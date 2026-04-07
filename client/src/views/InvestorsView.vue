<template>
  <div class="trucks-page admin-page" style="overflow-y:auto;min-height:auto;flex:none;">
    <div class="page-header">
      <h2>Investor Database</h2>
    </div>

    <details class="form-accordion">
      <summary class="form-toggle">+ Add Investor</summary>
      <AddInvestorForm
        :carrier-names="store.carrierNames"
        @submit="handleAdd"
      />
    </details>

    <template v-if="store.isLoading">
      <SkeletonLoader :rows="4" :cols="6" />
    </template>
    <template v-else>
      <InvestorTable
        :investors="store.investors"
        :carrier-names="store.carrierNames"
        @delete="handleDelete"
        @update="handleUpdate"
      />
    </template>
  </div>
</template>

<script setup>
import { onMounted } from 'vue'
import { useInvestorsStore } from '../stores/investors'
import { useToast } from '../composables/useToast'
import AddInvestorForm from '../components/investors/AddInvestorForm.vue'
import InvestorTable from '../components/investors/InvestorTable.vue'
import SkeletonLoader from '../components/shared/SkeletonLoader.vue'

const store = useInvestorsStore()
const { show: toast } = useToast()

async function handleAdd(data) {
  try {
    await store.add(data)
    toast('Investor added')
  } catch (err) {
    toast(err.message || 'Failed to add investor', 'error')
  }
}

async function handleUpdate({ id, data }) {
  try {
    await store.update(id, data)
    toast('Investor updated')
  } catch (err) {
    toast(err.message || 'Failed to update investor', 'error')
  }
}

async function handleDelete(id) {
  try {
    await store.remove(id)
    toast('Investor deleted')
  } catch {
    toast('Failed to delete investor', 'error')
  }
}

onMounted(() => {
  store.load()
  store.loadCarrierNames()
})
</script>
