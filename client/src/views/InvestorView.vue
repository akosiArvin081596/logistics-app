<template>
  <div class="investor-dashboard admin-page">
    <div class="page-header">
      <h2>Financial &amp; Investor Dashboard</h2>
      <div class="header-actions">
        <button class="btn-refresh" :disabled="store.isLoading" @click="loadData">
          {{ store.isLoading ? 'Loading...' : 'Refresh' }}
        </button>
        <span class="status-pill">{{ statusText }}</span>
      </div>
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
      <RecessionSection v-if="store.recessionProof" :recession-proof="store.recessionProof" :config="store.config" />
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
import RecessionSection from '../components/investor/RecessionSection.vue'
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

.header-actions {
  display: flex;
  align-items: center;
  gap: 0.75rem;
}

.btn-refresh {
  padding: 0.4rem 1rem;
  font-size: 0.78rem;
  font-weight: 600;
  font-family: inherit;
  border: 1px solid var(--border);
  border-radius: 6px;
  background: var(--surface);
  color: var(--text-dim);
  cursor: pointer;
  transition: all 0.15s;
}
.btn-refresh:hover { background: var(--bg); color: var(--text); }
.btn-refresh:disabled { opacity: 0.4; cursor: not-allowed; }

.skeleton-block {
  height: 200px;
  margin-bottom: 1rem;
  border-radius: var(--radius);
}

</style>
