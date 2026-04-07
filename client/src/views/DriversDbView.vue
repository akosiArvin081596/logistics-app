<template>
  <div class="trucks-page admin-page" style="overflow-y:auto;min-height:auto;flex:none;">
    <div class="page-header">
      <h2>Driver Database</h2>
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
      />
    </template>
  </div>
</template>

<script setup>
import { onMounted, computed, ref } from 'vue'
import { useDriversDbStore } from '../stores/driversDb'
import { useApi } from '../composables/useApi'
import { useToast } from '../composables/useToast'
import AddDriverForm from '../components/drivers-db/AddDriverForm.vue'
import DriverTable from '../components/drivers-db/DriverTable.vue'
import SkeletonLoader from '../components/shared/SkeletonLoader.vue'

const store = useDriversDbStore()
const api = useApi()
const { show: toast } = useToast()
const driverRatings = ref({})
const truckAssignments = ref([])

const carrierNames = computed(() => {
  const col = store.headers.find(h => /carrier/i.test(h))
  if (!col) return []
  const names = store.drivers.map(r => (r[col] || '').trim()).filter(Boolean)
  return [...new Set(names)].sort()
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
