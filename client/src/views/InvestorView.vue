<template>
  <div class="investor-dashboard admin-page">
    <!-- Hero Header -->
    <div class="hero-header">
      <div class="hero-top">
        <div class="hero-identity">
          <!-- v-bind="dropzoneProps" goes on the WRAPPER, never on the inner
               input: the wrapper always preventDefault()s, so a drop that lands
               on the avatar can never fall through to the document and navigate
               the SPA away to render the file. -->
          <label
            v-if="canEditPicture"
            class="hero-avatar-wrap"
            :class="{ 'hero-avatar-uploading': picUploading, 'hero-avatar-drop': dragActive }"
            :title="avatarTitle"
            v-bind="dropzoneProps"
          >
            <img v-if="investorPicture" :src="investorPicture" class="hero-avatar-img" alt="Profile picture" />
            <div v-else class="hero-avatar-initials"><AvatarPlaceholder /></div>
            <div class="hero-avatar-overlay">
              <svg v-if="!picUploading" xmlns="http://www.w3.org/2000/svg" width="22" height="22" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M23 19a2 2 0 0 1-2 2H3a2 2 0 0 1-2-2V8a2 2 0 0 1 2-2h4l2-3h6l2 3h4a2 2 0 0 1 2 2z"/><circle cx="12" cy="13" r="4"/></svg>
              <div v-else class="hero-spinner"></div>
            </div>
            <!-- The label already opens the picker natively (the input is a
                 descendant) — no @click="openPicker", which opens it twice. -->
            <input v-bind="inputProps" class="hero-avatar-input" />
          </label>
          <!-- Read-only branch: deliberately NO drag handlers and no drop
               highlight. Someone who can't change this picture must not be
               offered a target that does nothing (admins previewing an
               investor portal land here, as does an investor with no record). -->
          <div v-else-if="investorPicture" class="hero-avatar-wrap hero-avatar-readonly">
            <img :src="investorPicture" class="hero-avatar-img" alt="Profile picture" />
          </div>
          <div>
            <h2 class="hero-title">{{ dashboardTitle }}</h2>
            <p class="hero-sub">Performance overview &middot; {{ todayFormatted }}</p>
          </div>
        </div>
      </div>
      <div class="header-actions-row">
        <a href="mailto:info@logisx.com" class="btn-email" title="Email LogisX Operations (info@logisx.com) about loads, dispatch, or anything operational">Contact Operations</a>
        <a href="mailto:dev@logisx.com" class="btn-email" title="Email LogisX Tech Support (dev@logisx.com) for portal or login issues">Contact Tech Support</a>
        <div class="report-group">
          <input v-model="reportStart" type="date" class="date-input" title="Start date of the report period" />
          <input v-model="reportEnd" type="date" class="date-input" title="End date of the report period" />
          <button
            class="btn-report"
            :disabled="reportLoading"
            :title="reportLoading ? 'Generating PDF...' : 'Download a PDF report of your financials for the selected date range'"
            @click="downloadReport"
          >
            {{ reportLoading ? 'Generating...' : 'Download Report' }}
          </button>
        </div>
        <button
          class="btn-refresh"
          :disabled="store.isLoading"
          :title="store.isLoading ? 'Loading latest data...' : 'Re-fetch the latest dashboard data from the server'"
          @click="loadData"
        >
          {{ store.isLoading ? 'Loading...' : 'Refresh' }}
        </button>
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
      <!-- No page-level maintenance disclaimer here: EarningsSection renders
           its own compact one directly below its header, which lands a single
           row under this point, and PayoutsSection carries another further
           down. Two copies of the same sentence separated only by a section
           header read as a rendering glitch. Same call as MyPayoutsView. -->
      <EarningsSection
        :production="store.production"
        :is-super-admin="false"
        @changed="loadData"
      />
      <div class="sections-row">
        <ProductionSection :production="store.production" :config="store.config" />
        <TrendSection :production="store.production" />
      </div>
      <MyLoadsSection :my-loads="store.myLoads" :config="store.config" />
      <AssetSection v-if="store.asset?.totalMiles > 0" :asset="store.asset" :config="store.config" />
      <MyTrucks :trucks="trucks" :production="store.production" :is-preview="store.isPreview" @reload="loadData" />
      <FleetBreakdownSection :trucks="trucks" :asset="store.asset" :production="store.production" />
      <CashFlowSection :production="store.production" :asset="store.asset" :config="store.config" />
      <LoadReportsSection :production="store.production" :config="store.config" :preview-user-id="store.previewUserId" />
      <ExpensesSection :trucks="trucks" :preview-user-id="store.previewUserId" />
      <PayoutsSection :preview-user-id="store.previewUserId" />
      <!-- <TaxShieldSection :tax-shield="taxShieldData" :config="store.config" /> -->
      <InvestorChat :trucks="trucks" :preview-user-id="store.previewUserId" :is-preview="store.isPreview" />
      <LegalDocumentPortal
        :trucks="trucks"
        :investor-id="store.isPreview ? (store.data?.investor?.id || null) : null"
        :read-only="store.isPreview"
      />
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
import { ref, computed, onMounted, watch } from 'vue'
import { useInvestorStore } from '../stores/investor'
import { useAuthStore } from '../stores/auth'
import { useApi } from '../composables/useApi'
import { useToast } from '../composables/useToast'
import { useFileDrop } from '../composables/useFileDrop'
import { useSocketRefresh } from '../composables/useSocketRefresh'
import { AVATAR_MAX_EDGE, compressImage, isDecodedImage } from '../lib/imageUtils'
import EarningsSection from '../components/investor/EarningsSection.vue'
import ProductionSection from '../components/investor/ProductionSection.vue'
import TrendSection from '../components/investor/TrendSection.vue'
import AssetSection from '../components/investor/AssetSection.vue'
import FleetBreakdownSection from '../components/investor/FleetBreakdownSection.vue'
import CashFlowSection from '../components/investor/CashFlowSection.vue'
import ExpensesSection from '../components/investor/ExpensesSection.vue'
import PayoutsSection from '../components/investor/PayoutsSection.vue'
import TaxShieldSection from '../components/investor/TaxShieldSection.vue'
import InvestorChat from '../components/investor/InvestorChat.vue'
import DocumentPortal from '../components/investor/DocumentPortal.vue'
import LegalDocumentPortal from '../components/investor/LegalDocumentPortal.vue'
import MyTrucks from '../components/investor/MyTrucks.vue'
import MyLoadsSection from '../components/investor/MyLoadsSection.vue'
import LoadReportsSection from '../components/investor/LoadReportsSection.vue'
import ConfigPanel from '../components/investor/ConfigPanel.vue'
import EmptyState from '../components/shared/EmptyState.vue'
import AvatarPlaceholder from '../components/shared/AvatarPlaceholder.vue'

const store = useInvestorStore()
const authStore = useAuthStore()
const api = useApi()
const { show: toast } = useToast()
useSocketRefresh('investor:changed', () => loadData(), 'investor')

const trucks = ref([])
const reportLoading = ref(false)
const reportStart = ref('')
const reportEnd = ref('')
const picUploading = ref(false)

const investorRecord = computed(() => store.data?.investor || null)
const investorPicture = computed(() => investorRecord.value?.profilePictureUrl || '')
// In preview mode the admin is read-only — never let the avatar overlay show.
const canEditPicture = computed(() => !store.isPreview && authStore.user?.role === 'Investor' && !!investorRecord.value?.id)

// Drag-and-drop + the only real type/size gate on this surface: `accept` on the
// input filters the OS dialog and NOTHING else, so a dropped file is checked
// here or nowhere. Only the editable branch of the hero avatar binds these —
// the read-only replica never becomes a drop target.
const {
  dropzoneProps,
  inputProps,
  dragActive,
  supportsDrag,
  error: dropError,
  notice: dropNotice,
} = useFileDrop({
  accept: 'image/*',
  maxSizeMb: 10,
  busy: picUploading,
  onFiles: (files) => onPicFiles(files),
})

// A refused file (wrong type, oversize, a dropped folder) has to say so — the
// avatar has no other feedback and a silent no-op reads as a broken control.
//
// ⚠️ flush:'sync' is load-bearing. handleFiles clears the message and re-sets it
// in the same tick, so with the default 'pre' flush the batched watcher compares
// the SAME string to itself, sees no change, and stays silent — meaning dropping
// the same oversize file twice toasts once. The toast auto-hides after 3s, so
// the second attempt would look like nothing happened at all.
watch(
  [dropError, dropNotice],
  ([err, note]) => {
    if (err) toast(err, 'error')
    else if (note) toast(note)
  },
  { flush: 'sync' },
)

const avatarTitle = computed(() =>
  supportsDrag.value
    ? 'Click, or drop an image here, to change your profile picture'
    : 'Tap to change your profile picture',
)

// Takes File[] from useFileDrop (picker and drop both land here already
// validated), not a DOM change event.
async function onPicFiles(files) {
  const file = files?.[0]
  if (!file || !investorRecord.value?.id) return
  picUploading.value = true
  try {
    const base64 = await compressImage(file, AVATAR_MAX_EDGE, { background: '#ffffff', quality: 0.9 })
    // compressImage hands back the RAW bytes when it can't decode the file, so
    // this is what keeps the payload the JPEG data URL this endpoint has always
    // been sent.
    if (!isDecodedImage(base64)) {
      toast("That image couldn't be read — try a different file", 'error')
      return
    }
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
    // No `event.target.value = ''` here any more — useFileDrop clears the input
    // BEFORE handling, so re-picking the same file after a failure still fires.
  }
}

function titleCase(s) {
  return s.replace(/\b\w/g, c => c.toUpperCase())
}

const dashboardTitle = computed(() => {
  // In preview mode, the admin should see the target investor's name in the
  // hero — matches what that investor sees when they log in themselves.
  if (store.isPreview) {
    const targetName = investorRecord.value?.fullName
      || investorRecord.value?.username
      || store.data?.investor?.companyName
      || ''
    return targetName ? `${titleCase(targetName)} - Asset Dashboard` : 'Asset Dashboard'
  }
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
    // Payout ledger — the Load Reports banner reads owed/paid/accruing from it,
    // so it must be fetched even though PayoutsSection also asks on mount (the
    // store dedupes concurrent calls into one request). Never throws.
    store.loadPayouts()
    try {
      const trucksUrl = store.isPreview
        ? `/api/trucks?as_user_id=${store.previewUserId}`
        : '/api/trucks'
      const data = await api.get(trucksUrl)
      trucks.value = data.trucks || []
    } catch { /* silent */ }
  } catch {
    toast('Failed to load investor data', 'error')
  }
}

function downloadReport() {
  // Direct same-origin download — no fetch/blob, so the saved file can't become a
  // name-less blob UUID (the bug investors hit). The endpoint sends
  // Content-Disposition: attachment and we also set an explicit filename.
  const params = new URLSearchParams()
  if (reportStart.value) params.set('start', reportStart.value)
  if (reportEnd.value) params.set('end', reportEnd.value)
  if (store.isPreview) params.set('as_user_id', String(store.previewUserId))
  const range = [reportStart.value, reportEnd.value].filter(Boolean).join('_')
  const a = document.createElement('a')
  a.href = `/api/investor/report${params.toString() ? `?${params.toString()}` : ''}`
  a.download = `investor-report${range ? '-' + range : ''}.pdf`
  document.body.appendChild(a)
  a.click()
  a.remove()
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
  transition: border-color 0.15s, box-shadow 0.15s;
}
.hero-avatar-wrap.hero-avatar-readonly {
  cursor: default;
}
.hero-avatar-wrap .hero-avatar-overlay { opacity: 0; }
.hero-avatar-wrap:hover:not(.hero-avatar-readonly) .hero-avatar-overlay,
.hero-avatar-wrap.hero-avatar-uploading .hero-avatar-overlay,
.hero-avatar-wrap.hero-avatar-drop .hero-avatar-overlay { opacity: 1; }
/* :hover is unreliable mid-drag, so dragActive drives the highlight. White
   rather than --accent: this sits on the dark hero gradient. Only ever applied
   to the editable branch — the read-only avatar has no drag handlers at all. */
.hero-avatar-wrap.hero-avatar-drop {
  border-color: #fff;
  box-shadow: 0 0 0 3px rgba(255, 255, 255, 0.55);
}
@media (prefers-reduced-motion: reduce) {
  .hero-avatar-wrap { transition: none; }
}
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

.header-actions-row {
  display: flex;
  align-items: center;
  gap: 0.75rem;
  margin-top: 0.75rem;
  flex-wrap: wrap;
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
  margin-top: 1rem;
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
.stat-formula {
  font-size: 0.5rem; font-family: 'JetBrains Mono', monospace;
  color: rgba(255, 255, 255, 0.25); font-style: italic; margin-top: 0.1rem;
  display: block;
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
.sections-row {
  display: grid;
  grid-template-columns: 1fr 1fr;
  gap: 1.25rem;
  margin-bottom: 1.25rem;
  align-items: stretch;
}
.sections-row > :deep(.section) {
  margin-bottom: 0;
}

@media (max-width: 900px) {
  .sections-grid, .sections-row {
    grid-template-columns: 1fr;
  }
  .quick-stats {
    flex-wrap: wrap;
    gap: 0.5rem;
  }
  .stat-divider { display: none; }
  .stat-item { min-width: 40%; }
  .header-actions-row { flex-wrap: wrap; }
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
