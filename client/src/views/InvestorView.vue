<template>
  <div class="investor-dashboard admin-page">
    <!-- Hero Header -->
    <div class="hero-header">
      <div class="hero-top">
        <div>
          <h2 class="hero-title">{{ dashboardTitle }}</h2>
          <p class="hero-sub">Performance overview &middot; {{ todayFormatted }}</p>
        </div>
        <div class="header-actions">
          <a href="mailto:info@logisx.com" class="btn-email">info@logisx.com</a>
          <a href="mailto:dev@logisx.com" class="btn-email">dev@logisx.com</a>
          <button class="btn-refresh" :disabled="store.isLoading" @click="loadData">
            {{ store.isLoading ? 'Loading...' : 'Refresh' }}
          </button>
        </div>
      </div>

      <!-- Quick Stats Strip -->
      <div v-if="store.data" class="quick-stats">
        <div class="stat-item">
          <span class="stat-value">{{ fmtK(store.production?.totalRevenue) }}</span>
          <span class="stat-label">Total Revenue</span>
        </div>
        <div class="stat-divider"></div>
        <div class="stat-item">
          <span class="stat-value">{{ store.production?.completedJobs || 0 }}</span>
          <span class="stat-label">Completed Loads</span>
        </div>
        <div class="stat-divider"></div>
        <div class="stat-item">
          <span class="stat-value">{{ store.asset?.totalTrucks || trucks.length || 0 }}</span>
          <span class="stat-label">Fleet Size</span>
        </div>
        <div class="stat-divider"></div>
        <div class="stat-item">
          <span class="stat-value accent">{{ fmtK(store.production?.avgDailyRevenue) }}</span>
          <span class="stat-label">Avg / Day</span>
        </div>
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
      <div class="sections-grid">
        <ProductionSection :production="store.production" :config="store.config" />
        <TrendSection :production="store.production" />
      </div>
      <AssetSection :asset="store.asset" :config="store.config" />
      <FleetBreakdownSection :trucks="trucks" :asset="store.asset" :production="store.production" />
      <CashFlowSection :production="store.production" :asset="store.asset" :config="store.config" />
      <TaxShieldSection :tax-shield="taxShieldData" :config="store.config" />
      <ConfigPanel
        v-if="authStore.user?.role === 'Super Admin'"
        :config="store.config"
        @save="handleSaveConfig"
      />
    </template>

    <!-- Error State -->
    <EmptyState v-else>Failed to load investor data.</EmptyState>
  </div>
</template>

<script setup>
import { ref, computed, onMounted } from 'vue'
import { useInvestorStore } from '../stores/investor'
import { useAuthStore } from '../stores/auth'
import { useApi } from '../composables/useApi'
import { useToast } from '../composables/useToast'
import ProductionSection from '../components/investor/ProductionSection.vue'
import TrendSection from '../components/investor/TrendSection.vue'
import AssetSection from '../components/investor/AssetSection.vue'
import FleetBreakdownSection from '../components/investor/FleetBreakdownSection.vue'
import CashFlowSection from '../components/investor/CashFlowSection.vue'
import TaxShieldSection from '../components/investor/TaxShieldSection.vue'
import ConfigPanel from '../components/investor/ConfigPanel.vue'
import EmptyState from '../components/shared/EmptyState.vue'

const store = useInvestorStore()
const authStore = useAuthStore()
const api = useApi()
const { show: toast } = useToast()

const trucks = ref([])

const dashboardTitle = computed(() => {
  if (authStore.user?.role === 'Super Admin') return 'Asset Dashboard'
  const name = authStore.user?.username || authStore.user?.name || ''
  return name ? `${name} - Asset Dashboard` : 'Asset Dashboard'
})

const todayFormatted = computed(() =>
  new Date().toLocaleDateString('en-US', { weekday: 'long', month: 'long', day: 'numeric', year: 'numeric' })
)

const taxShieldData = computed(() => {
  const ts = store.taxShield || {}
  const asset = store.asset || {}
  return { ...ts, purchasePrice: asset.purchasePrice }
})

function fmtK(n) {
  const v = Number(n || 0)
  if (v >= 1000000) return '$' + (v / 1000000).toFixed(1) + 'M'
  if (v >= 1000) return '$' + (v / 1000).toFixed(1) + 'K'
  return '$' + v.toLocaleString('en-US')
}

async function loadData() {
  try {
    await store.load()
    try {
      const data = await api.get('/api/trucks')
      trucks.value = data.trucks || []
    } catch { /* silent */ }
  } catch {
    toast('Failed to load investor data', 'error')
  }
}

async function handleSaveConfig(config) {
  try {
    await store.updateConfig(config)
    toast('Configuration saved')
    await store.load()
  } catch (err) {
    toast(err.message || 'Failed to save configuration', 'error')
  }
}

onMounted(() => {
  loadData()
})
</script>

<style scoped>
.investor-dashboard { padding-bottom: 6rem; }

/* Hero Header */
.hero-header {
  background: linear-gradient(135deg, #1a1a2e 0%, #16213e 50%, #0f3460 100%);
  border-radius: var(--radius);
  padding: 1.5rem 1.75rem;
  margin-bottom: 1.25rem;
  color: #fff;
}

.hero-top {
  display: flex;
  align-items: flex-start;
  justify-content: space-between;
  margin-bottom: 1.25rem;
}

.hero-title {
  font-size: 1.35rem;
  font-weight: 800;
  letter-spacing: -0.02em;
  margin: 0;
  color: #fff;
}

.hero-sub {
  font-size: 0.78rem;
  color: rgba(255, 255, 255, 0.55);
  margin-top: 0.25rem;
}

.header-actions {
  display: flex;
  align-items: center;
  gap: 0.75rem;
}

.btn-email {
  padding: 0.4rem 0.85rem;
  font-size: 0.75rem;
  font-weight: 600;
  font-family: inherit;
  border: 1px solid rgba(255, 255, 255, 0.2);
  border-radius: 6px;
  background: rgba(255, 255, 255, 0.08);
  color: rgba(255, 255, 255, 0.75);
  cursor: pointer;
  text-decoration: none;
  transition: all 0.15s;
}
.btn-email:hover { background: rgba(255, 255, 255, 0.15); color: #fff; }

.btn-refresh {
  padding: 0.4rem 1rem;
  font-size: 0.78rem;
  font-weight: 600;
  font-family: inherit;
  border: 1px solid rgba(255, 255, 255, 0.2);
  border-radius: 6px;
  background: rgba(255, 255, 255, 0.08);
  color: rgba(255, 255, 255, 0.8);
  cursor: pointer;
  transition: all 0.15s;
}
.btn-refresh:hover { background: rgba(255, 255, 255, 0.15); color: #fff; }
.btn-refresh:disabled { opacity: 0.3; cursor: not-allowed; }

/* Quick Stats Strip */
.quick-stats {
  display: flex;
  align-items: center;
  gap: 0;
  background: rgba(255, 255, 255, 0.06);
  border-radius: 10px;
  padding: 0.75rem 0;
}

.stat-item {
  flex: 1;
  text-align: center;
  display: flex;
  flex-direction: column;
  gap: 0.15rem;
}

.stat-value {
  font-family: 'JetBrains Mono', monospace;
  font-size: 1.25rem;
  font-weight: 800;
  color: #fff;
}

.stat-value.accent {
  color: #34d399;
}

.stat-label {
  font-size: 0.65rem;
  font-weight: 600;
  color: rgba(255, 255, 255, 0.45);
  text-transform: uppercase;
  letter-spacing: 0.06em;
}

.stat-divider {
  width: 1px;
  height: 32px;
  background: rgba(255, 255, 255, 0.1);
}

/* Sections grid for side-by-side */
.sections-grid {
  display: grid;
  grid-template-columns: 1fr 1fr;
  gap: 1.25rem;
  margin-bottom: 1.25rem;
}

.sections-grid > :deep(.section) {
  margin-bottom: 0;
}

@media (max-width: 900px) {
  .sections-grid {
    grid-template-columns: 1fr;
  }
  .quick-stats {
    flex-wrap: wrap;
    gap: 0.5rem;
  }
  .stat-divider { display: none; }
  .stat-item { min-width: 40%; }
}

.skeleton-block {
  height: 200px;
  margin-bottom: 1rem;
  border-radius: var(--radius);
}
</style>
