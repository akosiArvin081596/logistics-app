<template>
  <div class="investor-dashboard admin-page">
    <div class="page-header">
      <h2>Financial &amp; Investor Dashboard</h2>
      <span class="status-pill">{{ statusText }}</span>
    </div>

    <!-- Skeleton Loader -->
    <template v-if="store.isLoading">
      <div class="skeleton skeleton-block"></div>
      <div class="skeleton skeleton-block"></div>
      <div class="skeleton skeleton-block"></div>
    </template>

    <!-- Dashboard Content -->
    <template v-else-if="store.data">
      <ProductionSection :production="store.production" :config="store.config" />
      <AssetSection :asset="store.asset" :config="store.config" />
      <TaxShieldSection :tax-shield="taxShieldData" :config="store.config" />
    </template>

    <!-- Error State -->
    <EmptyState v-else>Failed to load investor data.</EmptyState>
  </div>
</template>

<script setup>
import { computed, onMounted } from 'vue'
import { useInvestorStore } from '../stores/investor'
import { useAuthStore } from '../stores/auth'
import { useToast } from '../composables/useToast'
import ProductionSection from '../components/investor/ProductionSection.vue'
import AssetSection from '../components/investor/AssetSection.vue'
import TaxShieldSection from '../components/investor/TaxShieldSection.vue'
import EmptyState from '../components/shared/EmptyState.vue'

const store = useInvestorStore()
const authStore = useAuthStore()
const { show: toast } = useToast()

const statusText = computed(() => (store.isLoading ? 'Loading...' : 'Read-Only'))

// Merge taxShield with purchasePrice from asset for the TaxShieldSection
const taxShieldData = computed(() => {
  const ts = store.taxShield || {}
  const asset = store.asset || {}
  return { ...ts, purchasePrice: asset.purchasePrice }
})

async function loadData() {
  try {
    await store.load()
  } catch {
    toast('Failed to load investor data', 'error')
  }
}

onMounted(() => {
  loadData()
})
</script>

<style scoped>
.investor-dashboard { padding-bottom: 6rem; }

.skeleton-block {
  height: 200px;
  margin-bottom: 1rem;
  border-radius: var(--radius);
}

</style>
