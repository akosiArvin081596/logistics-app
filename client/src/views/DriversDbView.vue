<template>
  <div class="trucks-page admin-page" style="overflow-y:auto;min-height:auto;flex:none;">
    <div class="page-header">
      <h2>Driver Database</h2>
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

    <details class="form-accordion">
      <summary class="form-toggle">+ Add Driver <span class="form-toggle-note">(Case-by-case basis only — should go through the proper application process)</span></summary>
      <AddDriverForm
        :carrier-names="carrierNames"
        @submit="handleAdd"
      />
    </details>

    <template v-if="store.isLoading">
      <SkeletonLoader :rows="4" :cols="10" />
    </template>
    <template v-else>
      <DriverTable
        :drivers="store.drivers"
        :headers="store.headers"
        :carrier-names="carrierNames"
        :driver-ratings="driverRatings"
        :truck-assignments="truckAssignments"
        @delete="handleDelete"
        @update="handleUpdate"
        @picture-updated="store.load()"
      />
    </template>
  </div>
</template>

<script setup>
import { onMounted, computed, ref } from 'vue'
import { useDriversDbStore } from '../stores/driversDb'
import { useApi } from '../composables/useApi'
import { useToast } from '../composables/useToast'
import { useSocketRefresh } from '../composables/useSocketRefresh'
import AddDriverForm from '../components/drivers-db/AddDriverForm.vue'
import DriverTable from '../components/drivers-db/DriverTable.vue'
import SkeletonLoader from '../components/shared/SkeletonLoader.vue'
import { Card, CardContent } from '@/components/ui/card'

const store = useDriversDbStore()
const api = useApi()
const { show: toast } = useToast()
useSocketRefresh('drivers:changed', () => store.load())
const driverRatings = ref({})
const truckAssignments = ref([])

const carrierNames = computed(() => {
  const col = store.headers.find(h => /carrier/i.test(h))
  if (!col) return []
  const names = store.drivers.map(r => (r[col] || '').trim()).filter(Boolean)
  return [...new Set(names)].sort()
})

const kpiCards = computed(() => {
  const drv = store.drivers
  const active = drv.filter(d => (d.Status || '').toLowerCase() === 'active').length
  const pending = drv.filter(d => (d.Status || '').toLowerCase() === 'pending').length
  const withTruck = drv.filter(d => (d.Trucks || '').trim() !== '').length
  return [
    { label: 'Total Drivers', value: drv.length, sub: 'In directory',                icon: '&#128100;', theme: 'kpi-blue',    iconTheme: 'kpi-icon-blue' },
    { label: 'Active',        value: active,     sub: 'Ready to dispatch',           icon: '&#10003;',  theme: 'kpi-emerald', iconTheme: 'kpi-icon-emerald' },
    { label: 'Pending',       value: pending,    sub: 'Awaiting drug test',          icon: '&#9203;',   theme: 'kpi-amber',   iconTheme: 'kpi-icon-amber' },
    { label: 'Assigned',      value: `${withTruck}/${drv.length}`, sub: 'Linked to a truck', icon: '&#128279;', theme: 'kpi-violet',  iconTheme: 'kpi-icon-violet' },
  ]
})

async function handleAdd(values) {
  try {
    await store.add(values)
    toast('Driver added')
  } catch (err) {
    toast(err.message || 'Failed to add driver', 'error')
  }
}

async function handleUpdate({ rowIndex, values }) {
  try {
    await store.update(rowIndex, values)
    toast('Driver updated')
  } catch (err) {
    toast(err.message || 'Failed to update driver', 'error')
  }
}

async function handleDelete(rowIndex) {
  try {
    await store.remove(rowIndex)
    toast('Driver deleted')
  } catch {
    toast('Failed to delete driver', 'error')
  }
}

onMounted(async () => {
  store.load()
  try { const d = await api.get('/api/load-ratings/averages'); driverRatings.value = d.averages || {} } catch {}
  try { const d = await api.get('/api/truck-assignments'); truckAssignments.value = d.assignments || [] } catch {}
})
</script>
