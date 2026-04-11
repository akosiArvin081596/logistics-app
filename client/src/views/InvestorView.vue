<template>
  <div class="investor-dashboard admin-page">
    <!-- Hero Header -->
    <div class="hero-header">
      <div class="hero-top">
        <div class="hero-identity">
          <label v-if="canEditPicture" class="hero-avatar-wrap" :class="{ 'hero-avatar-uploading': picUploading }" title="Click to change profile picture">
            <img v-if="investorPicture" :src="investorPicture" class="hero-avatar-img" alt="Profile picture" />
            <div v-else class="hero-avatar-initials">{{ investorInitials }}</div>
            <div class="hero-avatar-overlay">
              <svg v-if="!picUploading" xmlns="http://www.w3.org/2000/svg" width="22" height="22" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M23 19a2 2 0 0 1-2 2H3a2 2 0 0 1-2-2V8a2 2 0 0 1 2-2h4l2-3h6l2 3h4a2 2 0 0 1 2 2z"/><circle cx="12" cy="13" r="4"/></svg>
              <div v-else class="hero-spinner"></div>
            </div>
            <input type="file" accept="image/*" class="hero-avatar-input" @change="onPicChange" />
          </label>
          <div v-else-if="investorPicture" class="hero-avatar-wrap hero-avatar-readonly">
            <img :src="investorPicture" class="hero-avatar-img" alt="Profile picture" />
          </div>
          <div>
            <h2 class="hero-title">{{ dashboardTitle }}</h2>
            <p class="hero-sub">Performance overview &middot; {{ todayFormatted }}</p>
          </div>
        </div>
        <div class="header-actions">
          <a href="mailto:info@logisx.com" class="btn-email">Contact Operations</a>
          <a href="mailto:dev@logisx.com" class="btn-email">Contact Tech Support</a>
          <div class="report-group">
            <input v-model="reportStart" type="date" class="date-input" title="Report start date" />
            <input v-model="reportEnd" type="date" class="date-input" title="Report end date" />
            <button class="btn-report" :disabled="reportLoading" @click="downloadReport">
              {{ reportLoading ? 'Generating...' : 'Download Report' }}
            </button>
          </div>
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
          <span class="stat-value" style="color:#f59e0b">{{ fmtK(store.production?.totalExpenses) }}</span>
          <span class="stat-label">Expenses</span>
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
      <MyTrucks :trucks="trucks" @reload="loadData" />
      <FleetBreakdownSection :trucks="trucks" :asset="store.asset" :production="store.production" />
      <CashFlowSection :production="store.production" :asset="store.asset" :config="store.config" />
      <!-- <TaxShieldSection :tax-shield="taxShieldData" :config="store.config" /> -->
      <InvestorChat :trucks="trucks" />
      <LegalDocumentPortal :trucks="trucks" />
      <!-- Business Configuration hidden from investor view; admin manages via Admin Tools -->
      <!--
      <ConfigPanel
        v-if="authStore.user?.role === 'Super Admin'"
        :config="store.config"
        @save="handleSaveConfig"
      />
      -->
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
import { useSocketRefresh } from '../composables/useSocketRefresh'
import ProductionSection from '../components/investor/ProductionSection.vue'
import TrendSection from '../components/investor/TrendSection.vue'
import AssetSection from '../components/investor/AssetSection.vue'
import FleetBreakdownSection from '../components/investor/FleetBreakdownSection.vue'
import CashFlowSection from '../components/investor/CashFlowSection.vue'
import TaxShieldSection from '../components/investor/TaxShieldSection.vue'
import InvestorChat from '../components/investor/InvestorChat.vue'
import DocumentPortal from '../components/investor/DocumentPortal.vue'
import LegalDocumentPortal from '../components/investor/LegalDocumentPortal.vue'
import MyTrucks from '../components/investor/MyTrucks.vue'
import ConfigPanel from '../components/investor/ConfigPanel.vue'
import EmptyState from '../components/shared/EmptyState.vue'

const store = useInvestorStore()
const authStore = useAuthStore()
const api = useApi()
const { show: toast } = useToast()
useSocketRefresh('investor:changed', () => loadData())

const trucks = ref([])
const reportLoading = ref(false)
const reportStart = ref('')
const reportEnd = ref('')
const picUploading = ref(false)

const investorRecord = computed(() => store.data?.investor || null)
const investorPicture = computed(() => investorRecord.value?.profilePictureUrl || '')
const canEditPicture = computed(() => authStore.user?.role === 'Investor' && !!investorRecord.value?.id)
const investorInitials = computed(() => {
  const name = authStore.user?.companyName || authStore.user?.fullName || authStore.user?.username || '?'
  return name
    .split(/\s+/)
    .map(w => w[0])
    .join('')
    .toUpperCase()
    .slice(0, 2)
})

async function onPicChange(event) {
  const file = event.target.files?.[0]
  if (!file || !investorRecord.value?.id) return
  picUploading.value = true
  try {
    const base64 = await resizeImageToBase64(file, 512)
    await api.post(`/api/investors/${investorRecord.value.id}/profile-picture`, {
      fileData: base64,
      fileName: file.name,
    })
    await store.load()
    toast('Profile picture updated')
  } catch (err) {
    toast('Upload failed', 'error')
  } finally {
    picUploading.value = false
    event.target.value = ''
  }
}

function resizeImageToBase64(file, maxDim) {
  return new Promise((resolve, reject) => {
    const img = new Image()
    img.onload = () => {
      let { width, height } = img
      if (width > maxDim || height > maxDim) {
        if (width > height) { height = Math.round(height * maxDim / width); width = maxDim }
        else { width = Math.round(width * maxDim / height); height = maxDim }
      }
      const canvas = document.createElement('canvas')
      canvas.width = width
      canvas.height = height
      const ctx = canvas.getContext('2d')
      ctx.fillStyle = '#ffffff'
      ctx.fillRect(0, 0, width, height)
      ctx.drawImage(img, 0, 0, width, height)
      resolve(canvas.toDataURL('image/jpeg', 0.9))
    }
    img.onerror = reject
    img.src = URL.createObjectURL(file)
  })
}

function titleCase(s) {
  return s.replace(/\b\w/g, c => c.toUpperCase())
}

const dashboardTitle = computed(() => {
  if (authStore.user?.role === 'Super Admin') return 'Asset Dashboard'
  const name = authStore.user?.companyName || authStore.user?.fullName || authStore.user?.username || ''
  return name ? `${titleCase(name)} - Asset Dashboard` : 'Asset Dashboard'
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

async function downloadReport() {
  reportLoading.value = true
  try {
    const params = new URLSearchParams()
    if (reportStart.value) params.set('start', reportStart.value)
    if (reportEnd.value) params.set('end', reportEnd.value)
    const qs = params.toString() ? `?${params.toString()}` : ''
    const res = await fetch(`/api/investor/report${qs}`, { credentials: 'include' })
    if (!res.ok) throw new Error('Failed')
    const blob = await res.blob()
    const url = URL.createObjectURL(blob)
    const a = document.createElement('a')
    a.href = url
    const cd = res.headers.get('Content-Disposition') || ''
    const match = cd.match(/filename="(.+)"/)
    a.download = match ? match[1] : 'report.pdf'
    a.click()
    URL.revokeObjectURL(url)
  } catch {
    toast('Failed to generate report', 'error')
  } finally {
    reportLoading.value = false
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

.hero-identity {
  display: flex;
  align-items: center;
  gap: 1rem;
}

.hero-avatar-wrap {
  position: relative;
  width: 72px;
  height: 72px;
  flex-shrink: 0;
  cursor: pointer;
  border-radius: 50%;
  overflow: hidden;
  border: 2px solid rgba(255, 255, 255, 0.2);
}
.hero-avatar-wrap.hero-avatar-readonly {
  cursor: default;
}
.hero-avatar-wrap .hero-avatar-overlay { opacity: 0; }
.hero-avatar-wrap:hover:not(.hero-avatar-readonly) .hero-avatar-overlay,
.hero-avatar-wrap.hero-avatar-uploading .hero-avatar-overlay { opacity: 1; }
.hero-avatar-img {
  width: 100%;
  height: 100%;
  object-fit: cover;
  display: block;
}
.hero-avatar-initials {
  width: 100%;
  height: 100%;
  display: flex;
  align-items: center;
  justify-content: center;
  background: rgba(255, 255, 255, 0.1);
  color: #fff;
  font-size: 1.5rem;
  font-weight: 700;
}
.hero-avatar-overlay {
  position: absolute;
  inset: 0;
  background: rgba(0, 0, 0, 0.5);
  color: #fff;
  display: flex;
  align-items: center;
  justify-content: center;
  transition: opacity 0.15s;
  border-radius: 50%;
}
.hero-avatar-input {
  position: absolute;
  inset: 0;
  opacity: 0;
  cursor: pointer;
  width: 100%;
  height: 100%;
}
.hero-spinner {
  width: 22px;
  height: 22px;
  border: 2px solid rgba(255, 255, 255, 0.3);
  border-top-color: #fff;
  border-radius: 50%;
  animation: hero-spin 0.7s linear infinite;
}
@keyframes hero-spin { to { transform: rotate(360deg); } }

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

.report-group {
  display: flex; align-items: center; gap: 0.4rem;
}
.date-input {
  padding: 0.35rem 0.55rem; font-size: 0.73rem; font-family: inherit;
  border: 1px solid rgba(255, 255, 255, 0.2); border-radius: 6px;
  background: rgba(255, 255, 255, 0.08); color: rgba(255, 255, 255, 0.8);
  cursor: pointer; width: 130px;
}
.date-input::-webkit-calendar-picker-indicator { filter: invert(1); opacity: 0.5; }
.btn-report {
  padding: 0.4rem 1rem;
  font-size: 0.78rem;
  font-weight: 600;
  font-family: inherit;
  border: 1px solid rgba(52, 211, 153, 0.5);
  border-radius: 6px;
  background: rgba(52, 211, 153, 0.12);
  color: #34d399;
  cursor: pointer;
  transition: all 0.15s;
}
.btn-report:hover { background: rgba(52, 211, 153, 0.22); }
.btn-report:disabled { opacity: 0.4; cursor: not-allowed; }

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
  .header-actions { flex-wrap: wrap; }
  .report-group { flex-wrap: wrap; }
}

@media (max-width: 600px) {
  .inv-header { padding: 1rem; }
  .inv-header h1 { font-size: 1.1rem; }
  .header-actions { flex-wrap: wrap; gap: 0.4rem; }
  .report-group { flex-wrap: wrap; gap: 0.4rem; width: 100%; }
  .date-input { width: auto; flex: 1; min-width: 100px; }
  .btn-email, .btn-report, .btn-refresh { font-size: 0.7rem; padding: 0.35rem 0.6rem; }
  .stat-value { font-size: 1rem; }
  .stat-item { min-width: 45%; }
  .quick-stats { padding: 0.5rem 0; }
}

.skeleton-block {
  height: 200px;
  margin-bottom: 1rem;
  border-radius: var(--radius);
}
</style>
