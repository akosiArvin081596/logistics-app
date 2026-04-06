<template>
  <div class="admin-page p-6">
    <div class="flex items-center justify-between mb-6">
      <div>
        <h2 class="text-xl font-semibold">Trailer Database</h2>
        <p class="text-sm text-muted-foreground">Manage trailers and assign to trucks</p>
      </div>
      <Dialog v-model:open="showForm">
        <DialogTrigger as-child>
          <Button @click="openAdd">+ Add Trailer</Button>
        </DialogTrigger>
        <DialogContent class="sm:max-w-[500px]">
          <DialogHeader>
            <DialogTitle>{{ editing ? 'Edit Trailer' : 'Add Trailer' }}</DialogTitle>
            <DialogDescription>{{ editing ? 'Update trailer details.' : 'Add a new trailer to the fleet.' }}</DialogDescription>
          </DialogHeader>
          <form @submit.prevent="handleSubmit" class="space-y-4 mt-2">
            <div class="grid grid-cols-2 gap-4">
              <div class="space-y-1">
                <label class="text-sm font-medium">Trailer Number *</label>
                <Input v-model="form.trailer_number" placeholder="e.g. TRL-2001" required />
              </div>
              <div class="space-y-1">
                <label class="text-sm font-medium">Type</label>
                <Select v-model="form.type">
                  <SelectTrigger><SelectValue placeholder="Select type" /></SelectTrigger>
                  <SelectContent>
                    <SelectItem v-for="t in trailerTypes" :key="t" :value="t">{{ t }}</SelectItem>
                  </SelectContent>
                </Select>
              </div>
            </div>
            <div class="grid grid-cols-3 gap-4">
              <div class="space-y-1">
                <label class="text-sm font-medium">Length</label>
                <Input v-model="form.length" placeholder="53" />
              </div>
              <div class="space-y-1">
                <label class="text-sm font-medium">Year</label>
                <Input v-model.number="form.year" type="number" placeholder="2024" />
              </div>
              <div class="space-y-1">
                <label class="text-sm font-medium">Status</label>
                <Select v-model="form.status">
                  <SelectTrigger><SelectValue placeholder="Status" /></SelectTrigger>
                  <SelectContent>
                    <SelectItem v-for="s in statuses" :key="s" :value="s">{{ s }}</SelectItem>
                  </SelectContent>
                </Select>
              </div>
            </div>
            <div class="grid grid-cols-2 gap-4">
              <div class="space-y-1">
                <label class="text-sm font-medium">VIN</label>
                <Input v-model="form.vin" placeholder="Vehicle ID number" />
              </div>
              <div class="space-y-1">
                <label class="text-sm font-medium">License Plate</label>
                <Input v-model="form.license_plate" placeholder="Plate number" />
              </div>
            </div>
            <div class="space-y-1">
              <label class="text-sm font-medium">Assign to Truck</label>
              <Select v-model="form.truck_id">
                <SelectTrigger><SelectValue placeholder="Select truck (optional)" /></SelectTrigger>
                <SelectContent>
                  <SelectItem value="">None</SelectItem>
                  <SelectItem v-for="t in truckOptions" :key="t.id" :value="String(t.id)">
                    {{ t.unit_number || 'Truck #' + t.id }} - {{ t.make }} {{ t.model }} ({{ t.assigned_driver || 'No driver' }})
                  </SelectItem>
                </SelectContent>
              </Select>
            </div>
            <div class="space-y-1">
              <label class="text-sm font-medium">Notes</label>
              <Input v-model="form.notes" placeholder="Optional notes" />
            </div>
            <div v-if="formError" class="text-sm text-red-500">{{ formError }}</div>
            <DialogFooter>
              <Button type="button" variant="outline" @click="showForm = false">Cancel</Button>
              <Button type="submit" :disabled="submitting">{{ submitting ? 'Saving...' : (editing ? 'Update' : 'Create') }}</Button>
            </DialogFooter>
          </form>
        </DialogContent>
      </Dialog>
    </div>

    <Card>
      <CardContent class="p-0">
        <div v-if="store.loading" class="p-8 text-center text-muted-foreground">Loading trailers...</div>
        <div v-else-if="store.trailers.length === 0" class="p-8 text-center text-muted-foreground">No trailers yet. Add one to get started.</div>
        <Table v-else>
          <TableHeader>
            <TableRow>
              <TableHead>Trailer #</TableHead>
              <TableHead>Type</TableHead>
              <TableHead>Length</TableHead>
              <TableHead>Status</TableHead>
              <TableHead>Assigned Truck</TableHead>
              <TableHead>Driver</TableHead>
              <TableHead>Year</TableHead>
              <TableHead class="text-right">Actions</TableHead>
            </TableRow>
          </TableHeader>
          <TableBody>
            <TableRow v-for="trailer in store.trailers" :key="trailer.id">
              <TableCell class="font-medium">{{ trailer.trailer_number }}</TableCell>
              <TableCell>
                <Badge :variant="typeVariant(trailer.type)">{{ trailer.type }}</Badge>
              </TableCell>
              <TableCell>{{ trailer.length }}ft</TableCell>
              <TableCell>
                <Badge :variant="statusVariant(trailer.status)">{{ trailer.status }}</Badge>
              </TableCell>
              <TableCell>{{ trailer.truck_number || '---' }}</TableCell>
              <TableCell>{{ trailer.assigned_driver || '---' }}</TableCell>
              <TableCell>{{ trailer.year || '---' }}</TableCell>
              <TableCell class="text-right space-x-2">
                <Button size="sm" variant="outline" @click="openEdit(trailer)">Edit</Button>
                <Button size="sm" variant="destructive" @click="handleDelete(trailer)">Delete</Button>
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

const truckOptions = computed(() => {
  if (editing.value) {
    // Include the currently assigned truck + all unassigned trucks
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

function statusVariant(status) {
  if (status === 'Available') return 'default'
  if (status === 'In Use') return 'secondary'
  if (status === 'Maintenance') return 'outline'
  return 'destructive'
}

function typeVariant(type) {
  if (type === 'Reefer') return 'secondary'
  if (type === 'Flatbed') return 'outline'
  return 'default'
}

onMounted(() => store.load())
</script>
