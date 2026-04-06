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
            <Button class="bg-[hsl(199,89%,48%)] hover:bg-[hsl(199,89%,42%)] text-white rounded-lg" @click="openAdd">+ Add Trailer</Button>
          </DialogTrigger>
          <DialogContent class="sm:max-w-[540px] rounded-[14px] border-[#e8edf2] shadow-[0_8px_32px_rgba(0,0,0,0.12),0_2px_8px_rgba(0,0,0,0.06)] p-0 gap-0 overflow-hidden">
            <DialogHeader class="px-6 pt-5 pb-4 border-b border-[#e8edf2] bg-gradient-to-b from-gray-50/80 to-white">
              <DialogTitle class="text-[1.1rem] font-bold text-gray-900">{{ editing ? 'Edit Trailer' : 'New Trailer' }}</DialogTitle>
              <DialogDescription class="text-[13px] text-gray-400 mt-0.5">{{ editing ? 'Update trailer details and assignment.' : 'Add a new trailer to the fleet.' }}</DialogDescription>
            </DialogHeader>
            <form @submit.prevent="handleSubmit" class="px-6 py-5 space-y-5">
              <!-- Row 1: Trailer # + Type -->
              <div class="grid grid-cols-2 gap-4">
                <div class="space-y-1.5">
                  <label class="text-[12px] font-semibold text-gray-500">Trailer Number *</label>
                  <Input v-model="form.trailer_number" placeholder="e.g. TRL-2001" class="rounded-lg border-[#e2e4ea] bg-[#f5f6fa] focus-visible:ring-[hsl(199,89%,48%)] focus-visible:border-[hsl(199,89%,48%)]" required />
                </div>
                <div class="space-y-1.5">
                  <label class="text-[12px] font-semibold text-gray-500">Type</label>
                  <Select v-model="form.type">
                    <SelectTrigger class="rounded-lg border-[#e2e4ea] bg-[#f5f6fa] focus:ring-[hsl(199,89%,48%)]"><SelectValue placeholder="Select type" /></SelectTrigger>
                    <SelectContent class="rounded-lg border-[#e2e4ea]">
                      <SelectItem v-for="t in trailerTypes" :key="t" :value="t">{{ t }}</SelectItem>
                    </SelectContent>
                  </Select>
                </div>
              </div>
              <!-- Row 2: Length + Year + Status -->
              <div class="grid grid-cols-3 gap-4">
                <div class="space-y-1.5">
                  <label class="text-[12px] font-semibold text-gray-500">Length (ft)</label>
                  <Input v-model="form.length" placeholder="53" class="rounded-lg border-[#e2e4ea] bg-[#f5f6fa] focus-visible:ring-[hsl(199,89%,48%)]" />
                </div>
                <div class="space-y-1.5">
                  <label class="text-[12px] font-semibold text-gray-500">Year</label>
                  <Input v-model.number="form.year" type="number" placeholder="2024" class="rounded-lg border-[#e2e4ea] bg-[#f5f6fa] focus-visible:ring-[hsl(199,89%,48%)]" />
                </div>
                <div class="space-y-1.5">
                  <label class="text-[12px] font-semibold text-gray-500">Status</label>
                  <Select v-model="form.status">
                    <SelectTrigger class="rounded-lg border-[#e2e4ea] bg-[#f5f6fa]"><SelectValue placeholder="Status" /></SelectTrigger>
                    <SelectContent class="rounded-lg border-[#e2e4ea]">
                      <SelectItem v-for="s in statuses" :key="s" :value="s">{{ s }}</SelectItem>
                    </SelectContent>
                  </Select>
                </div>
              </div>
              <!-- Row 3: VIN + Plate -->
              <div class="grid grid-cols-2 gap-4">
                <div class="space-y-1.5">
                  <label class="text-[12px] font-semibold text-gray-500">VIN</label>
                  <Input v-model="form.vin" placeholder="Vehicle ID number" class="rounded-lg border-[#e2e4ea] bg-[#f5f6fa] focus-visible:ring-[hsl(199,89%,48%)]" />
                </div>
                <div class="space-y-1.5">
                  <label class="text-[12px] font-semibold text-gray-500">License Plate</label>
                  <Input v-model="form.license_plate" placeholder="Plate number" class="rounded-lg border-[#e2e4ea] bg-[#f5f6fa] focus-visible:ring-[hsl(199,89%,48%)]" />
                </div>
              </div>
              <!-- Assign to Truck -->
              <div class="space-y-1.5">
                <label class="text-[12px] font-semibold text-gray-500">Assign to Truck</label>
                <Select v-model="form.truck_id">
                  <SelectTrigger class="rounded-lg border-[#e2e4ea] bg-[#f5f6fa]"><SelectValue placeholder="Select truck (optional)" /></SelectTrigger>
                  <SelectContent class="rounded-lg border-[#e2e4ea]">
                    <SelectItem value="">None</SelectItem>
                    <SelectItem v-for="t in truckOptions" :key="t.id" :value="String(t.id)">
                      {{ t.unit_number || 'Truck #' + t.id }} — {{ t.make }} {{ t.model }} ({{ t.assigned_driver || 'No driver' }})
                    </SelectItem>
                  </SelectContent>
                </Select>
              </div>
              <!-- Notes -->
              <div class="space-y-1.5">
                <label class="text-[12px] font-semibold text-gray-500">Notes</label>
                <Input v-model="form.notes" placeholder="Optional notes" class="rounded-lg border-[#e2e4ea] bg-[#f5f6fa] focus-visible:ring-[hsl(199,89%,48%)]" />
              </div>
              <!-- Error -->
              <div v-if="formError" class="text-[13px] text-red-600 bg-red-50 border border-red-200 rounded-lg px-3 py-2">{{ formError }}</div>
              <!-- Actions -->
              <DialogFooter class="pt-3 border-t border-[#e8edf2] gap-2">
                <Button type="button" variant="outline" class="rounded-lg border-[#e2e4ea]" @click="showForm = false">Cancel</Button>
                <Button type="submit" :disabled="submitting" class="rounded-lg bg-[hsl(199,89%,48%)] hover:bg-[hsl(199,89%,42%)] text-white">{{ submitting ? 'Saving...' : (editing ? 'Update' : 'Create') }}</Button>
              </DialogFooter>
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
                <Badge :class="typeBadge(trailer.type)">{{ trailer.type }}</Badge>
              </TableCell>
              <TableCell class="text-[13px] text-gray-600">{{ trailer.length }}ft</TableCell>
              <TableCell>
                <Badge :class="statusBadge(trailer.status)">{{ trailer.status }}</Badge>
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
                  <Button size="sm" variant="outline" class="rounded-md border-[#e2e4ea] text-[12px] h-8" @click="openEdit(trailer)">Edit</Button>
                  <Button size="sm" variant="outline" class="rounded-md border-red-200 text-red-600 hover:bg-red-50 hover:text-red-700 text-[12px] h-8" @click="handleDelete(trailer)">Delete</Button>
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
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { Card, CardContent } from '@/components/ui/card'
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from '@/components/ui/table'
import { Badge } from '@/components/ui/badge'
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle, DialogTrigger } from '@/components/ui/dialog'
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select'

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
  if (status === 'Available') return 'bg-emerald-50 text-emerald-700 border border-emerald-200 text-[11px] font-semibold'
  if (status === 'In Use') return 'bg-blue-50 text-blue-700 border border-blue-200 text-[11px] font-semibold'
  if (status === 'Maintenance') return 'bg-amber-50 text-amber-700 border border-amber-200 text-[11px] font-semibold'
  return 'bg-red-50 text-red-700 border border-red-200 text-[11px] font-semibold'
}

function typeBadge(type) {
  if (type === 'Reefer') return 'bg-cyan-50 text-cyan-700 border border-cyan-200 text-[11px] font-semibold'
  if (type === 'Flatbed') return 'bg-orange-50 text-orange-700 border border-orange-200 text-[11px] font-semibold'
  if (type === 'Step Deck') return 'bg-purple-50 text-purple-700 border border-purple-200 text-[11px] font-semibold'
  return 'bg-gray-50 text-gray-600 border border-gray-200 text-[11px] font-semibold'
}

onMounted(() => store.load())
</script>
