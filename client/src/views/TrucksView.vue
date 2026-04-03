<template>
  <div class="trucks-page admin-page" style="overflow-y:auto;min-height:auto;flex:none;">
    <div class="page-header">
      <h2>Truck Database</h2>
    </div>

    <AddTruckForm
      v-if="authStore.user?.role === 'Super Admin'"
      :driver-names="store.availableDriverNames"
      :investor-users="store.investorUsers"
      :show-owner="true"
      @submit="handleAddTruck"
    />

    <template v-if="store.isLoading">
      <SkeletonLoader :rows="4" :cols="7" />
    </template>
    <template v-else>
      <TruckTable
        :trucks="store.trucks"
        :driver-names="store.driverNames"
        :investor-users="store.investorUsers"
        :show-owner="authStore.user?.role === 'Super Admin'"
        :can-edit="authStore.user?.role === 'Super Admin'"
        @delete="handleDeleteTruck"
        @update="handleUpdateTruck"
      />
    </template>
  </div>
</template>

<script setup>
import { onMounted } from 'vue'
import { useTrucksStore } from '../stores/trucks'
import { useAuthStore } from '../stores/auth'
import { useToast } from '../composables/useToast'
import AddTruckForm from '../components/trucks/AddTruckForm.vue'
import TruckTable from '../components/trucks/TruckTable.vue'
import SkeletonLoader from '../components/shared/SkeletonLoader.vue'

const store = useTrucksStore()
const authStore = useAuthStore()
const { show: toast } = useToast()

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
  if (authStore.user?.role === 'Super Admin') {
    store.loadInvestorUsers()
  }
})
</script>
