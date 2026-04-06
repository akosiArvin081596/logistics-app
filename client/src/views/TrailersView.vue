<template>
  <div class="flex flex-col overflow-hidden h-full">
    <div class="dash-header">
      <div>
        <h2 class="text-[1.4rem] font-bold text-gray-900 tracking-tight">Trailer Database</h2>
        <p class="text-[13px] text-gray-400 mt-0.5">Manage trailers and assign to trucks</p>
      </div>
      <div class="flex items-center gap-3">
        <span class="text-[11px] text-gray-400 font-mono bg-gray-50 px-3 py-1.5 rounded-full border border-gray-100">{{ store.trailers.length }} trailers</span>
        <Dialog v-model:open="showForm">
          <DialogTrigger as-child>
            <button class="px-4 py-2 text-sm font-semibold bg-[hsl(199,89%,48%)] text-white rounded-lg hover:bg-[hsl(199,89%,42%)] active:scale-[0.97] transition-all duration-150" @click="openAdd">+ Add Trailer</button>
          </DialogTrigger>
          <DialogContent class="trailer-dialog sm:max-w-[520px]">
            <DialogHeader class="trailer-dialog-header">
              <DialogTitle>{{ editing ? 'Edit Trailer' : 'New Trailer' }}</DialogTitle>
              <DialogDescription>{{ editing ? 'Update trailer details and assignment.' : 'Add a new trailer to the fleet.' }}</DialogDescription>
            </DialogHeader>
            <form @submit.prevent="handleSubmit" class="trailer-form">
              <div class="form-row">
                <div class="form-group">
                  <label class="form-label">Trailer Number *</label>
                  <input v-model="form.trailer_number" class="form-input" placeholder="e.g. TRL-2001" required />
                </div>
                <div class="form-group">
                  <label class="form-label">Type</label>
                  <select v-model="form.type" class="form-select">
                    <option v-for="t in trailerTypes" :key="t" :value="t">{{ t }}</option>
                  </select>
                </div>
              </div>
              <div class="form-row" style="grid-template-columns: 1fr 1fr 1fr;">
                <div class="form-group">
                  <label class="form-label">Length (ft)</label>
                  <input v-model="form.length" class="form-input" placeholder="53" />
                </div>
                <div class="form-group">
                  <label class="form-label">Year</label>
                  <input v-model.number="form.year" class="form-input" type="number" placeholder="2024" />
                </div>
                <div class="form-group">
                  <label class="form-label">Status</label>
                  <select v-model="form.status" class="form-select">
                    <option v-for="s in statuses" :key="s" :value="s">{{ s }}</option>
                  </select>
                </div>
              </div>
              <div class="form-row">
                <div class="form-group">
                  <label class="form-label">VIN</label>
                  <input v-model="form.vin" class="form-input" placeholder="Vehicle ID number" />
                </div>
                <div class="form-group">
                  <label class="form-label">License Plate</label>
                  <input v-model="form.license_plate" class="form-input" placeholder="Plate number" />
                </div>
              </div>
              <div class="form-group">
                <label class="form-label">Assign to Truck</label>
                <select v-model="form.truck_id" class="form-select">
                  <option value="">None</option>
                  <option v-for="t in truckOptions" :key="t.id" :value="String(t.id)">
                    {{ t.unit_number || 'Truck #' + t.id }} — {{ t.make }} {{ t.model }} ({{ t.assigned_driver || 'No driver' }})
                  </option>
                </select>
              </div>
              <div class="form-group">
                <label class="form-label">Notes</label>
                <input v-model="form.notes" class="form-input" placeholder="Optional notes" />
              </div>
              <div v-if="formError" class="form-error">{{ formError }}</div>
              <div class="form-actions">
                <button type="button" class="btn btn-secondary" @click="showForm = false">Cancel</button>
                <button type="submit" :disabled="submitting" class="btn btn-primary">{{ submitting ? 'Saving...' : (editing ? 'Update' : 'Create') }}</button>
              </div>
            </form>
          </DialogContent>
        </Dialog>
      </div>
    </div>

    <!-- KPI Summary -->
    <div class="kpi-grid" style="margin-bottom:1.25rem;">
      <Card v-for="card in kpiCards" :key="card.label" class="kpi-card" :class="card.theme">
        <CardContent class="flex items-center gap-4" style="padding:1rem 1.25rem;">
          <div :class="['kpi-icon', card.iconTheme]" v-html="card.icon"></div>
          <div class="kpi-info">
            <div class="kpi-label">{{ card.label }}</div>
            <div class="kpi-value">{{ card.value }}</div>
            <div class="kpi-sub">{{ card.sub }}</div>
          </div>
        </CardContent>
      </Card>
    </div>

    <!-- Trailer Table -->
    <Card class="flex-1 flex flex-col min-h-0 overflow-hidden" style="border-radius:14px;border:1px solid #e8edf2;box-shadow:0 1px 4px rgba(0,0,0,0.06), 0 4px 12px rgba(0,0,0,0.04);">
      <CardContent class="flex-1 overflow-y-auto" style="padding:0;">
        <div v-if="store.loading" class="flex items-center justify-center py-16">
          <div class="text-[13px] text-gray-400">Loading trailers...</div>
        </div>
        <div v-else-if="store.trailers.length === 0" class="flex flex-col items-center justify-center py-16 gap-2">
          <div class="text-[2rem]">&#128718;</div>
          <div class="text-[14px] text-gray-500 font-medium">No trailers yet</div>
          <div class="text-[12px] text-gray-400">Add a trailer to get started</div>
        </div>
        <Table v-else>
          <TableHeader>
            <TableRow class="bg-gray-50/80 hover:bg-gray-50/80">
              <TableHead class="text-[11px] font-bold text-gray-500 uppercase tracking-wider">Trailer #</TableHead>
              <TableHead class="text-[11px] font-bold text-gray-500 uppercase tracking-wider">Type</TableHead>
              <TableHead class="text-[11px] font-bold text-gray-500 uppercase tracking-wider">Length</TableHead>
              <TableHead class="text-[11px] font-bold text-gray-500 uppercase tracking-wider">Status</TableHead>
              <TableHead class="text-[11px] font-bold text-gray-500 uppercase tracking-wider">Assigned Truck</TableHead>
              <TableHead class="text-[11px] font-bold text-gray-500 uppercase tracking-wider">Driver</TableHead>
              <TableHead class="text-[11px] font-bold text-gray-500 uppercase tracking-wider">Year</TableHead>
              <TableHead class="text-[11px] font-bold text-gray-500 uppercase tracking-wider text-right">Actions</TableHead>
            </TableRow>
          </TableHeader>
          <TableBody>
            <TableRow v-for="trailer in store.trailers" :key="trailer.id" class="hover:bg-blue-50/30 transition-colors duration-100">
              <TableCell class="font-semibold text-[13px] text-gray-900">{{ trailer.trailer_number }}</TableCell>
              <TableCell>
                <span :class="['inline-flex items-center px-2.5 py-0.5 rounded-full text-[11px] font-semibold', typeBadge(trailer.type)]">{{ trailer.type }}</span>
              </TableCell>
              <TableCell class="text-[13px] text-gray-600">{{ trailer.length }}ft</TableCell>
              <TableCell>
                <span :class="['inline-flex items-center px-2.5 py-0.5 rounded-full text-[11px] font-semibold', statusBadge(trailer.status)]">{{ trailer.status }}</span>
              </TableCell>
              <TableCell class="text-[13px] text-gray-600">
                <span v-if="trailer.truck_number">{{ trailer.truck_number }}</span>
                <span v-else class="text-gray-300">&mdash;</span>
              </TableCell>
              <TableCell class="text-[13px] text-gray-600">
                <span v-if="trailer.assigned_driver">{{ trailer.assigned_driver }}</span>
                <span v-else class="text-gray-300">&mdash;</span>
              </TableCell>
              <TableCell class="text-[13px] text-gray-500">{{ trailer.year || '---' }}</TableCell>
              <TableCell class="text-right">
                <div class="flex items-center justify-end gap-1.5">
                  <button class="px-3 py-1.5 text-[12px] font-semibold text-gray-600 bg-white border border-gray-200 rounded-md hover:border-gray-300 hover:shadow-sm transition-all duration-150" @click="openEdit(trailer)">Edit</button>
                  <button class="px-3 py-1.5 text-[12px] font-semibold text-red-600 bg-white border border-red-200 rounded-md hover:bg-red-50 hover:border-red-300 transition-all duration-150" @click="handleDelete(trailer)">Delete</button>
                </div>
              </TableCell>
            </TableRow>
          </TableBody>
        </Table>
      </CardContent>
    </Card>
  </div>
</template>

<script setup>
import { ref, computed, onMounted } from 'vue'
import { useTrailersStore } from '../stores/trailers'
import { useToast } from '../composables/useToast'
import { Card, CardContent } from '@/components/ui/card'
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from '@/components/ui/table'
import { Dialog, DialogContent, DialogDescription, DialogHeader, DialogTitle, DialogTrigger } from '@/components/ui/dialog'

const store = useTrailersStore()
const { show: toast } = useToast()

const showForm = ref(false)
const editing = ref(null)
const submitting = ref(false)
const formError = ref('')

const trailerTypes = ['Dry Van', 'Reefer', 'Flatbed', 'Step Deck', 'Lowboy', 'Tanker', 'Other']
const statuses = ['Available', 'In Use', 'Maintenance', 'Out of Service']

const defaultForm = () => ({
  trailer_number: '',
  type: 'Dry Van',
  length: '53',
  year: new Date().getFullYear(),
  vin: '',
  license_plate: '',
  status: 'Available',
  truck_id: '',
  notes: '',
})

const form = ref(defaultForm())

const kpiCards = computed(() => {
  const t = store.trailers
  const available = t.filter(x => x.status === 'Available').length
  const inUse = t.filter(x => x.status === 'In Use').length
  const maintenance = t.filter(x => x.status === 'Maintenance' || x.status === 'Out of Service').length
  const assigned = t.filter(x => x.truck_id).length
  return [
    { label: 'Total Trailers', value: t.length, sub: 'In fleet', icon: '&#128718;', theme: 'kpi-blue', iconTheme: 'kpi-icon-blue' },
    { label: 'Available', value: available, sub: 'Ready for use', icon: '&#10003;', theme: 'kpi-emerald', iconTheme: 'kpi-icon-emerald' },
    { label: 'In Use', value: inUse, sub: 'Currently active', icon: '&#9654;', theme: 'kpi-amber', iconTheme: 'kpi-icon-amber' },
    { label: 'Assigned to Truck', value: `${assigned}/${t.length}`, sub: `${maintenance} in maintenance`, icon: '&#128279;', theme: 'kpi-violet', iconTheme: 'kpi-icon-violet' },
  ]
})

const truckOptions = computed(() => {
  if (editing.value) {
    return store.trucks.filter(t => {
      const assignedToOther = store.trailers.some(tr => tr.truck_id === t.id && tr.id !== editing.value.id)
      return !assignedToOther
    })
  }
  return store.availableTrucks
})

function openAdd() {
  editing.value = null
  form.value = defaultForm()
  formError.value = ''
}

function openEdit(trailer) {
  editing.value = trailer
  form.value = {
    trailer_number: trailer.trailer_number,
    type: trailer.type,
    length: trailer.length || '53',
    year: trailer.year || 0,
    vin: trailer.vin || '',
    license_plate: trailer.license_plate || '',
    status: trailer.status,
    truck_id: trailer.truck_id ? String(trailer.truck_id) : '',
    notes: trailer.notes || '',
  }
  formError.value = ''
  showForm.value = true
}

async function handleSubmit() {
  formError.value = ''
  if (!form.value.trailer_number.trim()) {
    formError.value = 'Trailer number is required'
    return
  }
  submitting.value = true
  try {
    const payload = {
      ...form.value,
      truck_id: form.value.truck_id ? parseInt(form.value.truck_id) : null,
    }
    if (editing.value) {
      await store.update(editing.value.id, payload)
      toast('Trailer updated', 'success')
    } else {
      await store.create(payload)
      toast('Trailer created', 'success')
    }
    showForm.value = false
  } catch (err) {
    formError.value = err.message || 'Failed to save trailer'
  } finally {
    submitting.value = false
  }
}

async function handleDelete(trailer) {
  if (!confirm(`Delete trailer ${trailer.trailer_number}?`)) return
  try {
    await store.remove(trailer.id)
    toast('Trailer deleted', 'success')
  } catch (err) {
    toast(err.message || 'Failed to delete', 'error')
  }
}

function statusBadge(status) {
  if (status === 'Available') return 'bg-emerald-50 text-emerald-700 border border-emerald-200'
  if (status === 'In Use') return 'bg-blue-50 text-blue-700 border border-blue-200'
  if (status === 'Maintenance') return 'bg-amber-50 text-amber-700 border border-amber-200'
  return 'bg-red-50 text-red-700 border border-red-200'
}

function typeBadge(type) {
  if (type === 'Reefer') return 'bg-cyan-50 text-cyan-700 border border-cyan-200'
  if (type === 'Flatbed') return 'bg-orange-50 text-orange-700 border border-orange-200'
  if (type === 'Step Deck') return 'bg-purple-50 text-purple-700 border border-purple-200'
  return 'bg-gray-50 text-gray-700 border border-gray-200'
}

onMounted(() => store.load())
</script>

<style scoped>
.trailer-dialog {
  border-radius: 14px !important;
  border: 1px solid var(--border) !important;
  box-shadow: 0 8px 32px rgba(0,0,0,0.12), 0 2px 8px rgba(0,0,0,0.06) !important;
  padding: 0 !important;
  overflow: hidden;
}
.trailer-dialog-header {
  padding: 1.25rem 1.5rem 0.75rem;
  border-bottom: 1px solid var(--border);
  background: linear-gradient(to bottom, #fafbfc, var(--surface));
}
.trailer-dialog-header :deep([class*="DialogTitle"]) {
  font-size: 1.1rem;
  font-weight: 700;
  color: #111827;
}
.trailer-dialog-header :deep([class*="DialogDescription"]) {
  font-size: 0.78rem;
  color: var(--text-dim);
  margin-top: 0.15rem;
}
.trailer-form {
  padding: 1.25rem 1.5rem 1.5rem;
}
.trailer-form .form-group {
  margin-bottom: 0.85rem;
}
.trailer-form .form-label {
  display: block;
  font-size: 0.78rem;
  font-weight: 600;
  color: var(--text-dim);
  margin-bottom: 0.35rem;
}
.trailer-form .form-input,
.trailer-form .form-select {
  width: 100%;
  padding: 0.6rem 0.75rem;
  border: 1.5px solid var(--border);
  border-radius: 8px;
  font-family: inherit;
  font-size: 0.85rem;
  background: var(--bg);
  color: #111827;
  transition: border-color 0.15s, box-shadow 0.15s;
}
.trailer-form .form-input:focus,
.trailer-form .form-select:focus {
  outline: none;
  border-color: var(--accent);
  background: var(--surface);
  box-shadow: 0 0 0 3px var(--accent-dim);
}
.trailer-form .form-input::placeholder {
  color: var(--text-dim);
  opacity: 0.5;
}
.trailer-form .form-row {
  display: grid;
  grid-template-columns: 1fr 1fr;
  gap: 0.75rem;
}
.trailer-form .form-error {
  font-size: 0.78rem;
  color: #dc2626;
  background: #fef2f2;
  border: 1px solid #fecaca;
  border-radius: 8px;
  padding: 0.5rem 0.75rem;
  margin-bottom: 0.75rem;
}
.trailer-form .form-actions {
  display: flex;
  justify-content: flex-end;
  gap: 0.65rem;
  padding-top: 0.75rem;
  border-top: 1px solid var(--border);
  margin-top: 0.5rem;
}
.trailer-form .btn {
  padding: 0.55rem 1.25rem;
  font-size: 0.82rem;
  font-weight: 600;
  border-radius: 8px;
  border: 1.5px solid transparent;
  cursor: pointer;
  transition: all 0.15s;
  font-family: inherit;
}
.trailer-form .btn-primary {
  background: var(--accent);
  color: #fff;
  border-color: var(--accent);
}
.trailer-form .btn-primary:hover {
  filter: brightness(0.92);
}
.trailer-form .btn-primary:disabled {
  opacity: 0.5;
  cursor: not-allowed;
}
.trailer-form .btn-secondary {
  background: var(--surface);
  color: #374151;
  border-color: var(--border);
}
.trailer-form .btn-secondary:hover {
  border-color: #9ca3af;
  box-shadow: 0 1px 3px rgba(0,0,0,0.06);
}
@media (max-width: 600px) {
  .trailer-form .form-row { grid-template-columns: 1fr; }
}
</style>
