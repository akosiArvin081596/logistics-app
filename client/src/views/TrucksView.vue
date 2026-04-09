<template>
  <div class="trucks-page admin-page" style="overflow-y:auto;min-height:auto;flex:none;">
    <div class="page-header">
      <h2>Truck Database</h2>
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

    <details v-if="authStore.user?.role === 'Super Admin' || authStore.user?.role === 'Dispatcher'" class="form-accordion">
      <summary class="form-toggle">+ Add Truck</summary>
      <AddTruckForm
        :driver-names="store.driverNames"
        :investor-users="store.investorUsers"
        :show-owner="true"
        @submit="handleAddTruck"
      />
    </details>

    <template v-if="store.isLoading">
      <SkeletonLoader :rows="4" :cols="7" />
    </template>
    <template v-else>
      <TruckTable
        :trucks="store.trucks"
        :driver-names="store.driverNames"
        :investor-users="store.investorUsers"
        :show-owner="authStore.user?.role === 'Super Admin'"
        :can-edit="authStore.user?.role === 'Super Admin' || authStore.user?.role === 'Dispatcher'"
        @delete="handleDeleteTruck"
        @update="handleUpdateTruck"
      />
    </template>
  </div>
</template>

<script setup>
import { onMounted, computed } from 'vue'
import { useTrucksStore } from '../stores/trucks'
import { useAuthStore } from '../stores/auth'
import { useToast } from '../composables/useToast'
import AddTruckForm from '../components/trucks/AddTruckForm.vue'
import TruckTable from '../components/trucks/TruckTable.vue'
import SkeletonLoader from '../components/shared/SkeletonLoader.vue'
import { Card, CardContent } from '@/components/ui/card'

const store = useTrucksStore()
const authStore = useAuthStore()
const { show: toast } = useToast()

const kpiCards = computed(() => {
  const trucks = store.trucks
  const active = trucks.filter(t => t.Status === 'Active').length
  const maintenance = trucks.filter(t => t.Status === 'Maintenance' || t.Status === 'Out of Service').length
  const assigned = trucks.filter(t => (t.AssignedDriver || '').trim() !== '').length
  return [
    { label: 'Total Trucks',   value: trucks.length, sub: 'In fleet',           icon: '&#128663;', theme: 'kpi-blue',    iconTheme: 'kpi-icon-blue' },
    { label: 'Active',         value: active,        sub: 'On the road',        icon: '&#9654;',   theme: 'kpi-emerald', iconTheme: 'kpi-icon-emerald' },
    { label: 'In Maintenance', value: maintenance,   sub: 'Out of service',     icon: '&#128295;', theme: 'kpi-amber',   iconTheme: 'kpi-icon-amber' },
    { label: 'Assigned',       value: `${assigned}/${trucks.length}`, sub: 'With a driver', icon: '&#128279;', theme: 'kpi-violet',  iconTheme: 'kpi-icon-violet' },
  ]
})

async function handleAddTruck(data) {
  try {
    await store.addTruck(data)
    toast('Truck added')
  } catch (err) {
    toast(err.message || 'Failed to add truck', 'error')
  }
}

async function handleUpdateTruck({ id, data }) {
  try {
    await store.updateTruck(id, data)
    toast('Truck updated')
  } catch (err) {
    toast(err.message || 'Failed to update truck', 'error')
  }
}

async function handleDeleteTruck(id) {
  try {
    await store.deleteTruck(id)
    toast('Truck deleted')
  } catch {
    toast('Failed to delete truck', 'error')
  }
}

onMounted(() => {
  store.loadTrucks()
  store.loadDriverNames()
  if (authStore.user?.role === 'Super Admin' || authStore.user?.role === 'Dispatcher') {
    store.loadInvestorUsers()
  }
})
</script>
