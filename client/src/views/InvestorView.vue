<template>
  <div class="investor-dashboard admin-page page-narrow">
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
      <RecessionSection :recession-proof="store.recessionProof" />

      <!-- Config Editor (Admin only) -->
      <div v-if="authStore.isAdmin && store.config" class="section config-section">
        <div class="section-title">
          <div class="section-icon" style="background: var(--blue-dim); color: var(--blue);">&#9881;</div>
          Investor Configuration
        </div>
        <div class="config-form">
          <div class="config-row">
            <div class="form-group">
              <label class="form-label">Min Monthly Payout ($)</label>
              <input
                v-model.number="configForm.payoutMin"
                class="form-input"
                type="number"
                min="0"
                step="100"
              />
            </div>
            <div class="form-group">
              <label class="form-label">Max Monthly Payout ($)</label>
              <input
                v-model.number="configForm.payoutMax"
                class="form-input"
                type="number"
                min="0"
                step="100"
              />
            </div>
          </div>
          <button class="btn btn-primary btn-save" :disabled="isSaving" @click="saveConfig">
            {{ isSaving ? 'Saving...' : 'Update Payout Range' }}
          </button>
        </div>
      </div>
    </template>

    <!-- Error State -->
    <EmptyState v-else>Failed to load investor data.</EmptyState>
  </div>
</template>

<script setup>
import { ref, computed, onMounted } from 'vue'
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

const isSaving = ref(false)
const configForm = ref({ payoutMin: 0, payoutMax: 0 })

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
    if (store.config) {
      configForm.value.payoutMin = store.config.payoutMin ?? store.production?.payoutRange?.min ?? 0
      configForm.value.payoutMax = store.config.payoutMax ?? store.production?.payoutRange?.max ?? 0
    }
  } catch {
    toast('Failed to load investor data', 'error')
  }
}

async function saveConfig() {
  isSaving.value = true
  try {
    await store.updateConfig({
      payoutMin: configForm.value.payoutMin,
      payoutMax: configForm.value.payoutMax,
    })
    toast('Payout configuration updated')
    await store.load()
  } catch {
    toast('Failed to update configuration', 'error')
  } finally {
    isSaving.value = false
  }
}

onMounted(() => {
  loadData()
})
</script>

<style scoped>
.investor-dashboard { padding-bottom: 1.5rem; }

.skeleton-block {
  height: 200px;
  margin-bottom: 1rem;
  border-radius: var(--radius);
}

/* Config section */
.section {
  background: var(--surface);
  border: 1px solid var(--border);
  border-radius: var(--radius);
  padding: 1.25rem;
  margin-bottom: 1.25rem;
}

.section-title {
  font-size: 0.95rem;
  font-weight: 700;
  margin-bottom: 1rem;
  display: flex;
  align-items: center;
  gap: 0.5rem;
}

.section-icon {
  width: 28px;
  height: 28px;
  border-radius: 8px;
  display: flex;
  align-items: center;
  justify-content: center;
  font-size: 0.9rem;
}

.config-form {
  max-width: 500px;
}

.config-row {
  display: flex;
  gap: 1rem;
  margin-bottom: 1rem;
}

.config-row .form-group {
  flex: 1;
}

.btn-save {
  width: auto;
  padding: 0.5rem 1.5rem;
}
</style>
