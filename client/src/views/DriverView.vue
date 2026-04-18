<template>
  <div class="driver-app">
    <!-- ONBOARDING LOCK SCREEN — shown when driver is not fully onboarded -->
    <template v-if="isOnboarding">
      <DriverHeader :driver-name="driverName" @logout="handleLogout" />
      <main class="app-content onboarding-locked">
        <div class="ob-welcome">
          <div class="ob-welcome-icon">&#128075;</div>
          <div class="ob-welcome-title">Welcome, {{ driverName }}</div>
          <div class="ob-welcome-sub">Complete the steps below to get started with LogisX.</div>
        </div>

        <!-- Overall progress -->
        <div class="card ob-progress-card">
          <div class="ob-progress-header">
            <span class="ob-progress-label">Onboarding Progress</span>
            <span class="ob-progress-pct">{{ onboardingPct }}%</span>
          </div>
          <div class="ob-bar-track"><div class="ob-bar-fill" :style="{ width: onboardingPct + '%' }"></div></div>
        </div>

        <!-- Step 1: Sign documents -->
        <div class="card ob-step">
          <div class="ob-step-header">
            <div :class="['ob-step-num', allDocsSigned ? 'ob-done' : 'ob-active']">1</div>
            <div class="ob-step-info">
              <div class="ob-step-title">Sign Onboarding Documents</div>
              <div class="ob-step-sub">{{ signedCount }}/{{ totalDocs }} completed</div>
            </div>
          </div>
          <div class="ob-doc-list">
            <div v-for="doc in onboardingDocs" :key="doc.doc_key" class="ob-doc-item" @click="openOnboardingDoc(doc)">
              <div class="ob-doc-icon" v-html="doc.signed ? '&#9989;' : '&#9723;'"></div>
              <div class="ob-doc-name">{{ doc.doc_name }}</div>
              <div class="ob-doc-action">{{ doc.signed ? 'View' : 'Sign' }}</div>
            </div>
          </div>
        </div>

        <!-- Next-steps alert when all docs are signed -->
        <div v-if="allDocsSigned" class="card ob-step">
          <div class="ob-next-steps">
            <div class="ob-next-title">Onboarding Status: Documents Received!</div>
            <p>Thanks for getting your paperwork squared away. Now that the legal stuff is signed and uploaded, you've officially cleared Phase 1. We are currently reviewing your file.</p>
            <p><b>Here is what happens next:</b></p>
            <ul>
              <li><b>Pre-Employment Screening:</b> A member of our safety team will contact you shortly to schedule your pre-appointment screening. If you've already completed one recently for another carrier, let us know, but expect to be sent for a new one under the LogisX account.</li>
              <li><b>FMCSA Clearinghouse: This is mandatory.</b> If you haven't already, make sure you are enrolled in the <b>FMCSA Clearinghouse</b> and have granted LogisX Inc. permission to run your full query. We cannot put you in a truck until this is cleared.</li>
              <li><b>Driver Training:</b> While we finalize your background check, it's time to get in the right mindset. At LogisX, we pride ourselves on professional, elite operation.</li>
            </ul>
            <p>Stand by for a call from our safety coordinator.</p>
            <p><b>The LogisX Safety Team</b></p>
          </div>
        </div>

        <!-- Step 2: Complete -->
        <div class="card ob-step">
          <div class="ob-step-header">
            <div :class="['ob-step-num', 'ob-pending']">2</div>
            <div class="ob-step-info">
              <div class="ob-step-title">Start Driving</div>
              <div class="ob-step-sub">You'll be added to the fleet once all steps are complete</div>
            </div>
          </div>
        </div>
      </main>

      <!-- Document sign modal -->
      <DocumentSignModal
        :show="showSignModal"
        :doc="selectedDoc"
        :driver-name="driverStore.driverName"
        @close="showSignModal = false"
        @signed="onDocSigned"
      />
    </template>

    <!-- LOCATION LOCK SCREEN — shown to fully-onboarded drivers until the
         browser has granted geolocation permission. Replaces the normal UI
         entirely so dispatch cannot have a driver active without GPS. -->
    <template v-else-if="isLocationBlocked">
      <DriverHeader :driver-name="driverName" @logout="handleLogout" />
      <main class="app-content location-locked">
        <div class="card loc-card">
          <div class="loc-icon">&#128205;</div>
          <div class="loc-title">Location Access Required</div>
          <div class="loc-sub">
            LogisX needs your location so dispatch can track your progress and
            auto-update load status at pickup &amp; delivery. You can't receive
            assignments without it.
          </div>

          <div v-if="locationPermission === 'checking'" class="loc-status">
            Checking location access&hellip;
          </div>
          <div v-else-if="locationPermission === 'denied'" class="loc-guide">
            <p><b>Location is blocked for this site.</b> Re-enable it:</p>
            <ul>
              <li><b>iPhone Safari:</b> tap the "aA" icon in the address bar &rarr; Website Settings &rarr; Location &rarr; Allow.</li>
              <li><b>Android Chrome:</b> tap the lock icon in the address bar &rarr; Permissions &rarr; Location &rarr; Allow.</li>
              <li><b>Desktop:</b> click the lock in the address bar &rarr; Site Settings &rarr; Location &rarr; Allow, then reload.</li>
            </ul>
          </div>
          <div v-else-if="locationPermission === 'unavailable'" class="loc-guide">
            <p><b>Your device isn't returning a location.</b></p>
            <ul>
              <li><b>iPhone:</b> Settings &rarr; Privacy &amp; Security &rarr; Location Services &rarr; On.</li>
              <li><b>Android:</b> Quick Settings &rarr; tap the Location tile to turn it on.</li>
              <li>Move somewhere with a clearer view of the sky &mdash; parking garages and basements block GPS.</li>
            </ul>
          </div>
          <div v-else-if="locationPermission === 'timeout'" class="loc-guide">
            <p>Location request timed out. Try again from a spot with a better GPS signal.</p>
          </div>
          <div v-else-if="locationPermission === 'unsupported'" class="loc-guide">
            <p>This browser doesn't support location services. Try Chrome or Safari.</p>
          </div>
          <div v-else-if="locationPermission === 'error'" class="loc-guide">
            <p>{{ locationReason || 'Something went wrong while checking location.' }}</p>
          </div>

          <button class="loc-btn" :disabled="checkingPermission" @click="retryLocation">
            {{ checkingPermission ? 'Requesting&hellip;' : 'Turn on Location' }}
          </button>
          <button class="loc-btn-sub" @click="handleLogout">Log Out</button>
        </div>
      </main>
    </template>

    <!-- NORMAL DRIVER UI — shown when fully onboarded (or no onboarding record) -->
    <template v-else>
    <!-- Welcome / Activation Modal — shown once when a driver first lands here after becoming fully onboarded -->
    <div v-if="showWelcomeModal" class="welcome-overlay" @click.self="dismissWelcome">
      <div class="welcome-card">
        <div class="welcome-icon">&#127881;</div>
        <h2 class="welcome-title">Welcome to the Team!</h2>
        <p class="welcome-sub">Hey <b>{{ driverName }}</b> — you're now an official LogisX driver.</p>
        <div class="welcome-checklist">
          <div class="welcome-check"><span class="wc-icon">&#9989;</span> Onboarding documents signed</div>
          <div class="welcome-check"><span class="wc-icon">&#9989;</span> Pre-employment drug test passed</div>
          <div class="welcome-check"><span class="wc-icon">&#9989;</span> Added to the active fleet</div>
        </div>
        <p class="welcome-msg">Your account is active. You can now receive load assignments from dispatch, report your status on the road, and get paid. Drive safe out there.</p>
        <p class="welcome-signoff">&mdash; The LogisX Team</p>
        <button class="welcome-btn" @click="dismissWelcome">Let's Get Started</button>
      </div>
    </div>

    <!-- Load Assigned Notification -->
    <LoadAssignedBanner
      :notification="assignedNotification"
      @dismiss="dismissAssignedBanner"
      @view-load="viewAssignedLoad"
    />

    <!-- Distance Warning Banner -->
    <div v-if="activeDistanceWarning && detailLoad" class="distance-warning">
      <div class="warning-icon">&#9888;</div>
      <div class="warning-content">
        <div class="warning-title">
          {{ activeDistanceWarning.type === 'far-from-pickup' ? 'Far from Pickup' : 'Far from Delivery' }}
        </div>
        <div class="warning-message">{{ activeDistanceWarning.message }}</div>
      </div>
      <button class="warning-dismiss" @click="distanceWarningDismissed = true">&times;</button>
    </div>

    <!-- Header -->
    <DriverHeader
      :driver-name="driverName"
      @logout="handleLogout"
    />

    <!-- Main content area -->
    <main class="app-content">
      <!-- LOADS TAB -->
      <section v-if="currentTab === 'loads'" class="tab-panel">
        <!-- Load Detail Page -->
        <LoadDetail
          v-if="detailLoad"
          :load="detailLoad"
          :headers="driverMapHeaders"
          :driver-name="driverName"
          :has-active-job="driverStore.hasActiveJob"
          :driver-position="geo.lastPosition.value"
          :truck="driverStore.truck"
          :load-expenses="detailLoadExpenses"
          @back="detailRowIndex = null"
          @status-update="handleStatusUpdate"
          @uploaded="handleRefresh"
          @accept="handleAcceptLoad"
          @decline="handleDeclineLoad"
          @expense-submit="handleExpenseSubmit"
        />

        <!-- Load List -->
        <div v-else>
          <!-- Sub-tab bar -->
          <div class="load-sub-tabs">
            <button
              v-for="tab in subTabs"
              :key="tab.value"
              :class="['sub-tab', { active: driverStore.loadSubTab === tab.value }]"
              @click="driverStore.loadSubTab = tab.value"
            >
              {{ tab.label }}
              <span class="sub-tab-count">{{ subTabCount(tab.value) }}</span>
            </button>
          </div>

          <!-- Search & date filters -->
          <div class="section-header">
            <span class="section-count">{{ driverStore.filteredLoads.length }} results</span>
            <button class="filter-toggle" :class="{ active: showFilters }" @click="showFilters = !showFilters">
              &#9776; Filter
            </button>
          </div>

          <div v-show="showFilters" class="load-filters">
            <div class="filter-row">
              <input
                v-model="driverStore.filterSearch"
                type="text"
                class="filter-input"
                placeholder="Search load ID, origin, destination..."
              />
            </div>
            <div class="filter-row date-row">
              <div class="filter-group">
                <label class="filter-label">From</label>
                <input v-model="driverStore.filterDateFrom" type="date" class="filter-input" />
              </div>
              <div class="filter-group">
                <label class="filter-label">To</label>
                <input v-model="driverStore.filterDateTo" type="date" class="filter-input" />
              </div>
            </div>
            <button v-if="hasActiveFilters" class="clear-filters" @click="clearFilters">Clear filters</button>
          </div>

          <div v-if="driverStore.isLoading" class="loading-skeletons">
            <div class="skeleton skeleton-card"></div>
            <div class="skeleton skeleton-card"></div>
          </div>
          <div v-else-if="driverStore.filteredLoads.length === 0">
            <EmptyState>
              <div class="empty-icon">&#128230;</div>
              <template v-if="driverStore.loads.length > 0">
                No loads in this category.
              </template>
              <template v-else>
                No loads assigned.<br>Check back later.
              </template>
            </EmptyState>
          </div>
          <div v-else class="load-cards">
            <LoadCard
              v-for="load in driverStore.filteredLoads"
              :key="load._rowIndex"
              :load="load"
              :headers="driverStore.headers.jobTracking"
              :pending="driverStore.loadSubTab === 'pending'"
              :accepted="isLoadAccepted(load)"
              @select="handleLoadSelect"
              @chat="handleLoadChat"
              @accept="handleAcceptLoad"
              @decline="handleDeclineLoad"
            />
          </div>
        </div>
      </section>

      <!-- STATUS TAB -->
      <section v-if="currentTab === 'status'" class="tab-panel">
        <div class="section-header">Status Update</div>
        <div v-if="!currentActiveLoad">
          <EmptyState>
            <div class="empty-icon">&#128666;</div>
            No active loads to update.
          </EmptyState>
        </div>
        <div v-else>
          <div class="status-load-header">
            <span class="status-load-id">{{ getLoadId(currentActiveLoad) }}</span>
            <StatusBadge :status="getLoadStatus(currentActiveLoad)" />
          </div>

          <StatusStepper
            :load="currentActiveLoad"
            :headers="driverStore.headers.jobTracking"
            :current-status="getLoadStatus(currentActiveLoad)"
            :driver-name="driverName"
            @update="handleStatusUpdate"
          />

          <div class="status-section-divider">Documents</div>
          <DocumentUpload
            :load-id="getLoadId(currentActiveLoad)"
            :driver-name="driverName"
            :row-index="currentActiveLoad._rowIndex"
            @uploaded="onStatusDocUploaded"
          />
          <DocumentList ref="statusDocListRef" :load-id="getLoadId(currentActiveLoad)" />

          <div class="status-section-divider">Log Expense</div>
          <ExpenseForm
            v-if="currentActiveLoad"
            :loads="[currentActiveLoad]"
            :driver-name="driverName"
            :headers="driverStore.headers.jobTracking"
            @submit="handleExpenseSubmit"
          />
        </div>
      </section>

      <!-- KIT TAB -->
      <section v-if="currentTab === 'kit'" class="tab-panel">
        <div class="section-header">Driver Kit</div>
        <div v-if="driverStore.isLoading">
          <div class="skeleton skeleton-card"></div>
        </div>
        <DriverKit
          v-else
          :driver-info="driverStore.driverInfo"
          :headers="driverStore.headers.carrierDB"
          :shared-documents="driverStore.sharedDocuments"
          :truck-documents="driverStore.truckDocuments"
          :application="driverStore.application"
          :onboarding-documents="driverStore.onboarding?.documents || []"
          :profile-picture-url="driverStore.profilePictureUrl"
          :driver-id="driverStore.driverDirectoryId"
        />
      </section>

      <!-- NOTIFICATIONS TAB -->
      <section v-if="currentTab === 'notifications'" class="tab-panel">
        <NotificationList
          :notifications="driverStore.notifications"
          @tap="handleNotificationTap"
          @mark-all-read="handleMarkAllNotifRead"
        />
      </section>

      <!-- MESSAGES TAB -->
      <section v-if="currentTab === 'messages'" class="tab-panel">
        <ChatView
          :messages="driverStore.messages"
          :loads="driverStore.loads"
          :driver-name="driverName"
          @send="handleSendMessage"
          @mark-read="handleMarkRead"
        />
      </section>

      <!-- EXPENSES TAB -->
      <section v-if="currentTab === 'expenses'" class="tab-panel">
        <div class="section-header">Expenses</div>

        <ExpenseForm
          v-if="driverStore.workingLoads.length > 0"
          :loads="driverStore.workingLoads"
          :driver-name="driverName"
          :headers="driverStore.headers.jobTracking"
          @submit="handleExpenseSubmit"
        />
        <EmptyState v-else>
          No active loads.
        </EmptyState>

        <div class="section-header" style="margin-top: 1rem;">
          History
          <span class="section-count">{{ driverStore.expenses.length }}</span>
        </div>

        <div v-if="driverStore.expenses.length === 0">
          <EmptyState>
            <div class="empty-icon">&#128176;</div>
            No expenses logged yet.
          </EmptyState>
        </div>
        <div v-else class="expense-list">
          <ExpenseCard
            v-for="(exp, i) in driverStore.expenses"
            :key="exp.id || i"
            :expense="exp"
            @preview="receiptPreview = $event"
          />
        </div>
      </section>

      <!-- Receipt preview overlay (shared with any card in the expenses list) -->
      <Teleport to="body">
        <div v-if="receiptPreview" class="receipt-preview-overlay" @click="receiptPreview = ''">
          <img :src="receiptPreview" class="receipt-preview-img" alt="Receipt preview" />
        </div>
      </Teleport>

      <!-- INVOICES TAB -->
      <section v-if="currentTab === 'invoices'" class="tab-panel">
        <div class="section-header">Invoices</div>
        <InvoiceTab />
      </section>
    </main>

    <!-- Bottom Navigation -->
    <BottomNav
      :current-tab="currentTab"
      :unread-count="driverStore.unreadCount"
      :unread-notif-count="driverStore.unreadNotifCount"
      @switch="handleTabSwitch"
    />

    <!-- Decline confirmation overlay -->
    <div v-if="showDeclineConfirm" class="confirm-overlay" @click.self="showDeclineConfirm = false">
      <div class="confirm-dialog">
        <div class="confirm-title">Decline Load?</div>
        <div class="confirm-msg">This load will be returned to the dispatch board.</div>
        <div class="confirm-actions">
          <button class="confirm-btn cancel" @click="showDeclineConfirm = false">Cancel</button>
          <button class="confirm-btn danger" @click="confirmDecline">Decline</button>
        </div>
      </div>
    </div>
    </template><!-- end normal driver UI -->
  </div>
</template>

<script setup>
import 'vant/es/tabbar/style'
import 'vant/es/tabbar-item/style'
import 'vant/es/badge/style'
import 'vant/es/collapse/style'
import 'vant/es/collapse-item/style'
import 'vant/es/cell/style'
import 'vant/es/cell-group/style'
import 'vant/es/button/style'
import 'vant/es/empty/style'
import 'vant/es/form/style'
import 'vant/es/field/style'
import 'vant/es/uploader/style'
import 'vant/es/picker/style'
import 'vant/es/popup/style'
import 'vant/es/nav-bar/style'
import 'vant/es/steps/style'
import 'vant/es/step/style'
import { ref, computed, onMounted, onUnmounted, watch } from 'vue'
import { useRouter } from 'vue-router'
import { useAuthStore } from '../stores/auth'
import { useDriverStore } from '../stores/driver'
import { useSocket } from '../composables/useSocket'
import { useToast } from '../composables/useToast'
import { useGeolocation } from '../composables/useGeolocation'
import { useApi } from '../composables/useApi'

import DriverHeader from '../components/driver/DriverHeader.vue'
import BottomNav from '../components/driver/BottomNav.vue'
import LoadCard from '../components/driver/LoadCard.vue'
import LoadDetail from '../components/driver/LoadDetail.vue'
import StatusStepper from '../components/driver/StatusStepper.vue'
import ChatView from '../components/driver/ChatView.vue'
import ExpenseForm from '../components/driver/ExpenseForm.vue'
import ExpenseCard from '../components/driver/ExpenseCard.vue'
import DriverKit from '../components/driver/DriverKit.vue'
import DocumentUpload from '../components/driver/DocumentUpload.vue'
import DocumentList from '../components/driver/DocumentList.vue'
import LoadAssignedBanner from '../components/driver/LoadAssignedBanner.vue'
import NotificationList from '../components/driver/NotificationList.vue'
import OnboardingPanel from '../components/driver/OnboardingPanel.vue'
import DocumentSignModal from '../components/driver/DocumentSignModal.vue'
import InvoiceTab from '../components/driver/InvoiceTab.vue'
import EmptyState from '../components/shared/EmptyState.vue'
import StatusBadge from '../components/shared/StatusBadge.vue'

const auth = useAuthStore()
const driverStore = useDriverStore()
const socket = useSocket()
const toast = useToast()
const router = useRouter()
const api = useApi()
const geo = useGeolocation(api)

// Onboarding lock screen
const showSignModal = ref(false)
const selectedDoc = ref(null)
function openOnboardingDoc(doc) {
  selectedDoc.value = doc
  showSignModal.value = true
}
function onDocSigned(docKey) {
  // Update selectedDoc to the fresh signed version so modal shows signed state + PDF
  const fresh = driverStore.onboarding?.documents?.find(d => d.doc_key === docKey)
  if (fresh) selectedDoc.value = fresh
}
const isOnboarding = computed(() => {
  const ob = driverStore.onboarding
  return ob && ob.status !== 'fully_onboarded'
})
// True while we haven't confirmed browser geolocation permission. Drives the
// full-screen "Location Access Required" gate below, but only for drivers who
// are already through onboarding — unsigned-docs drivers still see their
// paperwork flow first.
const isLocationBlocked = computed(() => !isOnboarding.value && locationPermission.value !== 'granted')
const onboardingDocs = computed(() => driverStore.onboarding?.documents || [])
const totalDocs = computed(() => driverStore.onboarding?.totalDocs || 6)
const signedCount = computed(() => onboardingDocs.value.filter(d => d.signed).length)
const allDocsSigned = computed(() => signedCount.value === totalDocs.value)
// Drug test progress is intentionally NOT shown to drivers (legal requirement).
// Progress reflects document signing only; admin handles the final activation.
const onboardingPct = computed(() =>
  Math.round((signedCount.value / totalDocs.value) * 100)
)

const currentTab = ref('loads')
const selectedStatusRowIndex = ref(null)
const chatLoadId = ref('')
const showFilters = ref(false)
const detailRowIndex = ref(null)
const assignedNotification = ref(null)
const showWelcomeModal = ref(false)
const receiptPreview = ref('')

// Location permission gate state. Blocks the full driver UI until the
// browser geolocation permission is granted. See requestPermission() in
// useGeolocation for the state enum.
const locationPermission = ref('checking')
const locationReason = ref('')
const checkingPermission = ref(false)
let isMounted = false

// Welcome / activation modal — shows once per driver, first login after fully_onboarded
function welcomeStorageKey() {
  const uid = auth.user?.id || driverStore.onboarding?.user_id || 'anon'
  return `logisx_welcome_seen_${uid}`
}
function maybeShowWelcome() {
  const ob = driverStore.onboarding
  if (!ob || ob.status !== 'fully_onboarded') return
  if (!ob.onboarded_at) return
  // Only celebrate if onboarding happened recently (guards against existing drivers seeing this on every new deploy)
  const onboardedMs = new Date(ob.onboarded_at).getTime()
  if (isNaN(onboardedMs)) return
  const daysSince = (Date.now() - onboardedMs) / (1000 * 60 * 60 * 24)
  if (daysSince > 14) return
  try {
    if (localStorage.getItem(welcomeStorageKey())) return
  } catch { /* private mode */ }
  showWelcomeModal.value = true
}
function dismissWelcome() {
  showWelcomeModal.value = false
  try { localStorage.setItem(welcomeStorageKey(), new Date().toISOString()) } catch { /* ignore */ }
}
// If a driver is on the onboarding lock screen when the admin uploads their drug test,
// the store refreshes, isOnboarding flips to false — surface the celebration at that moment too.
watch(isOnboarding, (v, old) => {
  if (old === true && v === false) maybeShowWelcome()
})

const subTabs = [
  { label: 'Active', value: 'active' },
  { label: 'Pending', value: 'pending' },
  { label: 'Historical', value: 'historical' },
]

function subTabCount(tab) {
  if (tab === 'active') return driverStore.workingLoads.length
  if (tab === 'pending') return driverStore.pendingLoads.length
  if (tab === 'historical') return driverStore.historicalLoads.length
  return 0
}

const hasActiveFilters = computed(() =>
  driverStore.filterSearch.trim() !== '' ||
  driverStore.filterDateFrom !== '' ||
  driverStore.filterDateTo !== ''
)

function clearFilters() {
  driverStore.filterSearch = ''
  driverStore.filterDateFrom = ''
  driverStore.filterDateTo = ''
}

const driverName = computed(() => auth.user?.driverName || auth.user?.username || '')

// Load detail page (shown when a load card is tapped)
const detailLoadRaw = computed(() => {
  if (!detailRowIndex.value) return null
  return driverStore.loads.find(l => l._rowIndex === detailRowIndex.value) || null
})
const detailLoad = ref(null)
watch(detailLoadRaw, async (load) => {
  if (!load) { detailLoad.value = null; return }
  detailLoad.value = { ...load }
  const hdrs = driverStore.headers.jobTracking || []
  const hasLatCol = hdrs.some(h => /origin.*lat|pickup.*lat|dest.*lat|drop.*lat/i.test(h))
  if (!hasLatCol) {
    const lc = hdrs.find(h => /load.?id|job.?id/i.test(h))
    const lid = lc ? (load[lc] || '').toString().trim() : ''
    if (lid) {
      try {
        const g = await api.get(`/api/geocode/load/${encodeURIComponent(lid)}`)
        const enriched = { ...detailLoad.value }
        if (g.originLat) { enriched['Origin Lat'] = g.originLat; enriched['Origin Lng'] = g.originLng }
        if (g.destLat) { enriched['Dest Lat'] = g.destLat; enriched['Dest Lng'] = g.destLng }
        detailLoad.value = enriched
      } catch { /* silent */ }
    }
  }
}, { immediate: true })

const driverMapHeaders = computed(() => {
  const h = [...(driverStore.headers.jobTracking || [])]
  if (detailLoad.value && detailLoad.value['Origin Lat'] && !h.some(c => /origin.*lat/i.test(c))) {
    h.push('Origin Lat', 'Origin Lng', 'Dest Lat', 'Dest Lng')
  }
  return h
})

const detailLoadExpenses = computed(() => {
  if (!detailLoad.value) return []
  const hdrs = driverStore.headers.jobTracking || []
  const lidCol = hdrs.find(h => /load.?id|job.?id/i.test(h))
  const lid = lidCol ? (detailLoad.value[lidCol] || '').toString().trim() : ''
  if (!lid) return []
  return driverStore.expenses.filter(e => (e.load_id || '').toString().trim() === lid)
})

// Current active load for status tab (only working loads — not pending/delivered)
const currentActiveLoad = computed(() => {
  return driverStore.workingLoads[0] || null
})

// Client-side distance warning — computed from GPS position and the currently viewed load
const FAR_THRESHOLD_KM = 500
const clientDistanceWarning = computed(() => {
  const pos = geo.lastPosition.value
  const load = detailLoad.value
  if (!pos || !load) return null
  const headers = driverStore.headers.jobTracking
  const statusCol = findCol(headers, /status/i)
  const status = statusCol ? (load[statusCol] || '').trim().toLowerCase() : ''
  const notPickedUp = /^(dispatched|assigned)$/i.test(status)
  const inTransit = /^(in transit)$/i.test(status)
  if (!notPickedUp && !inTransit) return null

  const oLatCol = findCol(headers, /origin.*lat|pickup.*lat/i)
  const oLngCol = findCol(headers, /origin.*l(on|ng)|pickup.*l(on|ng)/i)
  const dLatCol = findCol(headers, /dest.*lat|drop.*lat|delivery.*lat/i)
  const dLngCol = findCol(headers, /dest.*l(on|ng)|drop.*l(on|ng)|delivery.*l(on|ng)/i)
  const loadIdCol = findCol(headers, /load.?id|job.?id/i)

  let targetLat, targetLng, type
  if (notPickedUp && oLatCol && oLngCol) {
    targetLat = parseFloat(load[oLatCol])
    targetLng = parseFloat(load[oLngCol])
    type = 'far-from-pickup'
  } else if (inTransit && dLatCol && dLngCol) {
    targetLat = parseFloat(load[dLatCol])
    targetLng = parseFloat(load[dLngCol])
    type = 'far-from-delivery'
  }
  if (!targetLat || !targetLng || isNaN(targetLat) || isNaN(targetLng)) return null

  // Haversine distance
  const R = 6371
  const toRad = d => d * Math.PI / 180
  const dLat = toRad(targetLat - pos.latitude)
  const dLng = toRad(targetLng - pos.longitude)
  const a = Math.sin(dLat/2)**2 + Math.cos(toRad(pos.latitude)) * Math.cos(toRad(targetLat)) * Math.sin(dLng/2)**2
  const distKm = R * 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1-a))

  if (distKm < FAR_THRESHOLD_KM) return null
  const distMiles = Math.round(distKm * 0.621371)
  const loadId = loadIdCol ? load[loadIdCol] || '' : ''
  return {
    type,
    distanceMiles: distMiles,
    message: `You are ${distMiles.toLocaleString()} miles from ${type === 'far-from-pickup' ? 'pickup' : 'delivery'} (Load ${loadId}). Please verify your route.`,
  }
})

const distanceWarningDismissed = ref(false)
const activeDistanceWarning = computed(() => {
  if (distanceWarningDismissed.value) return null
  return clientDistanceWarning.value || geo.distanceWarning.value
})

const statusDocListRef = ref(null)

function onStatusDocUploaded() {
  if (statusDocListRef.value) statusDocListRef.value.refresh()
  handleRefresh()
}

// Selected load for status tab (kept for compatibility)
const selectedLoad = computed(() => {
  if (!selectedStatusRowIndex.value && driverStore.activeLoads.length > 0) {
    return driverStore.activeLoads[0]
  }
  return driverStore.activeLoads.find(
    (l) => l._rowIndex === selectedStatusRowIndex.value
  ) || driverStore.activeLoads[0] || null
})

// Helpers
function findCol(headers, regex) {
  return (headers || []).find((h) => regex.test(h)) || null
}

function getLoadId(load) {
  const col = findCol(driverStore.headers.jobTracking, /load.?id|job.?id/i)
  return col ? load[col] || 'Row ' + load._rowIndex : 'Row ' + load._rowIndex
}

function getLoadStatus(load) {
  const col = findCol(driverStore.headers.jobTracking, /status/i)
  return col ? (load[col] || '').trim() : ''
}

// Tab switching
function handleTabSwitch(tab) {
  currentTab.value = tab
  driverStore.currentTab = tab

  if (tab === 'notifications') {
    const unreadIds = driverStore.notifications
      .filter((n) => !n.read)
      .map((n) => n.id)
    if (unreadIds.length > 0) {
      driverStore.markNotificationsRead(unreadIds)
    }
  }

  if (tab === 'messages') {
    const unreadIds = driverStore.messages
      .filter(
        (m) =>
          (m.to || '').toLowerCase() === driverName.value.toLowerCase() &&
          !m.read
      )
      .map((m) => m.id)
      .filter(Boolean)
    if (unreadIds.length > 0) {
      driverStore.markMessagesRead(unreadIds)
    }
  }
}

function handleNotificationTap(notif) {
  if (!notif.read) driverStore.markNotificationsRead([notif.id])
  try {
    const meta = JSON.parse(notif.metadata || '{}')
    if (notif.type === 'load-assigned' && meta.rowIndex) {
      currentTab.value = 'loads'
      driverStore.loadSubTab = 'active'
      detailRowIndex.value = meta.rowIndex
    } else if (notif.type === 'message') {
      currentTab.value = 'messages'
    }
  } catch {
    // ignore parse errors
  }
}

function handleMarkAllNotifRead() {
  const unreadIds = driverStore.notifications
    .filter((n) => !n.read)
    .map((n) => n.id)
  if (unreadIds.length > 0) driverStore.markNotificationsRead(unreadIds)
}

function isLoadAccepted(load) {
  const loadIdCol = findCol(driverStore.headers.jobTracking, /load.?id|job.?id/i)
  const lid = loadIdCol ? (load[loadIdCol] || '') : ''
  return driverStore.isLoadAccepted(lid)
}

async function handleAcceptLoad(load) {
  const loadIdCol = findCol(driverStore.headers.jobTracking, /load.?id|job.?id/i)
  const lid = loadIdCol ? (load[loadIdCol] || '') : ''
  try {
    await driverStore.respondToLoad(lid, load._rowIndex, 'accepted')
    toast.show('Load accepted')
  } catch {
    toast.show('Failed to accept load', 'error')
  }
}

const showDeclineConfirm = ref(false)
const declineTarget = ref(null)

function handleDeclineLoad(load) {
  declineTarget.value = load
  showDeclineConfirm.value = true
}

async function confirmDecline() {
  showDeclineConfirm.value = false
  const load = declineTarget.value
  if (!load) return
  const loadIdCol = findCol(driverStore.headers.jobTracking, /load.?id|job.?id/i)
  const lid = loadIdCol ? (load[loadIdCol] || '') : ''
  try {
    await driverStore.respondToLoad(lid, load._rowIndex, 'declined')
    toast.show('Load declined')
  } catch {
    toast.show('Failed to decline load', 'error')
  }
  declineTarget.value = null
}

function handleLoadSelect(load) {
  detailRowIndex.value = load._rowIndex
  distanceWarningDismissed.value = false
}

function handleLoadChat({ loadId }) {
  chatLoadId.value = loadId || ''
  currentTab.value = 'messages'
  driverStore.currentTab = 'messages'
}

function handleChatLoadChange(loadId) {
  chatLoadId.value = loadId
}

function onStatusLoadChange() {
  // selectedStatusRowIndex is already v-modeled
}

// Actions
async function handleRefresh() {
  try {
    await driverStore.loadData()
    toast.show('Data refreshed')
  } catch {
    toast.show('Failed to load data', 'error')
  }
}

async function handleLogout() {
  socket.disconnect()
  await auth.logout()
  router.push('/login')
}

async function handleStatusUpdate({ newStatus, load }) {
  const loadIdCol = findCol(driverStore.headers.jobTracking, /load.?id|job.?id/i)
  const loadId = loadIdCol ? load[loadIdCol] : ''

  try {
    await driverStore.updateStatus(loadId, newStatus, load._rowIndex, load)
    toast.show(`Status updated to ${newStatus}`)
  } catch {
    toast.show('Failed to update status', 'error')
  }
}

async function handleSendMessage({ recipient, message, loadId }) {
  try {
    await driverStore.sendMessage(recipient, message, loadId)
  } catch {
    toast.show('Failed to send message', 'error')
  }
}

function handleMarkRead(ids) {
  driverStore.markMessagesRead(ids)
}

async function handleExpenseSubmit(data) {
  try {
    await driverStore.submitExpense(data)
    toast.show('Expense submitted')
  } catch {
    toast.show('Failed to submit expense', 'error')
  }
}

// Socket.IO for real-time notifications
function onLoadAssigned(payload) {
  if (!isMounted) return
  assignedNotification.value = {
    loadId: payload.loadId || 'Load',
    origin: payload.origin || '',
    destination: payload.destination || '',
    rowIndex: payload.rowIndex
  }
  const route = [payload.origin, payload.destination].filter(Boolean).join(' \u2192 ')
  driverStore.addNotification({
    id: payload.notificationId || Date.now(),
    type: 'load-assigned',
    title: `New Load Assigned: ${payload.loadId || 'Load'}`,
    body: route,
    metadata: JSON.stringify(payload),
    read: 0,
    createdAt: new Date().toISOString(),
  })
  driverStore.loadData()
}

function dismissAssignedBanner() {
  assignedNotification.value = null
}

function viewAssignedLoad() {
  const ri = assignedNotification.value?.rowIndex
  assignedNotification.value = null
  if (ri) {
    currentTab.value = 'loads'
    driverStore.loadSubTab = 'active'
    detailRowIndex.value = ri
  }
}

function onLoadCancelled(payload) {
  if (!isMounted) return
  toast.show(`Load ${payload.loadId || ''} has been cancelled by dispatch`)
  driverStore.addNotification({
    id: payload.notificationId || Date.now(),
    type: 'load-cancelled',
    title: `Load Cancelled: ${payload.loadId || 'Load'}`,
    body: 'Your assignment has been cancelled by dispatch',
    metadata: JSON.stringify(payload),
    read: 0,
    createdAt: new Date().toISOString(),
  })
  driverStore.loadData()
}

function onGeofenceTrigger(payload) {
  if (!isMounted) return
  const statusMsg = payload.status === 'At Shipper'
    ? 'You have arrived at the pickup location'
    : 'You have arrived at the delivery location'
  toast.show(`${statusMsg} (Load ${payload.loadId})`)
  driverStore.addNotification({
    id: payload.notificationId || Date.now(),
    type: 'geofence',
    title: `${payload.status} — Load ${payload.loadId}`,
    body: statusMsg,
    metadata: JSON.stringify(payload),
    read: 0,
    createdAt: new Date().toISOString(),
  })
  // Reload data so load status updates and route recalculates from driver position
  driverStore.loadData()
}

function onNewMessage(msg) {
  if (!isMounted) return
  const myName = driverName.value.toLowerCase()
  const from = (msg.from || '').toLowerCase()
  const to = (msg.to || '').toLowerCase()

  if (from === myName || to === myName) {
    // Skip own sends (already added optimistically)
    if (from === myName) return

    driverStore.addIncomingMessage(msg)
    driverStore.addNotification({
      id: msg.notificationId || Date.now(),
      type: 'message',
      title: `New message from ${msg.from}`,
      body: msg.message.length > 100 ? msg.message.substring(0, 100) + '...' : msg.message,
      metadata: JSON.stringify({ from: msg.from, to: msg.to, loadId: msg.loadId || '' }),
      read: 0,
      createdAt: new Date().toISOString(),
    })

    if (currentTab.value !== 'messages') {
      toast.show('New message from ' + msg.from)
    }
  }
}

// Start GPS tracking when driver app loads, update loadId based on working loads
watch(
  () => driverStore.workingLoads,
  (working) => {
    if (working.length > 0) {
      const firstLoadId = getLoadId(working[0])
      if (!geo.tracking.value) {
        geo.start(firstLoadId)
      } else {
        geo.updateLoadId(firstLoadId)
      }
    } else {
      // No active loads — keep tracking but clear loadId
      if (!geo.tracking.value) {
        geo.start('')
      } else {
        geo.updateLoadId('')
      }
    }
  },
  { immediate: true }
)

// Keep selected status load in sync
watch(
  () => driverStore.activeLoads,
  (active) => {
    if (active.length > 0 && !selectedStatusRowIndex.value) {
      selectedStatusRowIndex.value = active[0]._rowIndex
    }
    if (
      selectedStatusRowIndex.value &&
      !active.find((l) => l._rowIndex === selectedStatusRowIndex.value)
    ) {
      selectedStatusRowIndex.value = active.length > 0 ? active[0]._rowIndex : null
    }
  },
  { immediate: true }
)

async function verifyLocationPermission() {
  checkingPermission.value = true
  try {
    const r = await geo.requestPermission()
    locationPermission.value = r.state
    locationReason.value = r.reason || ''
  } finally {
    checkingPermission.value = false
  }
}

async function retryLocation() {
  await verifyLocationPermission()
}

onMounted(async () => {
  isMounted = true
  driverStore.driverName = driverName.value
  try {
    await driverStore.loadData()
    maybeShowWelcome()
  } catch {
    toast.show('Failed to load data', 'error')
  }

  // Enforce geolocation permission once per session for fully-onboarded
  // drivers. Paperwork-stage drivers stay on the onboarding lock and don't
  // need GPS yet.
  if (!isOnboarding.value) {
    await verifyLocationPermission()
  }

  // Socket.IO
  socket.connect()
  socket.register(driverName.value)
  socket.on('new-message', onNewMessage)
  socket.on('load-assigned', onLoadAssigned)
  socket.on('load-cancelled', onLoadCancelled)
  socket.on('geofence-trigger', onGeofenceTrigger)
})

onUnmounted(() => {
  isMounted = false
  socket.off('new-message', onNewMessage)
  socket.off('load-assigned', onLoadAssigned)
  socket.off('load-cancelled', onLoadCancelled)
  socket.off('geofence-trigger', onGeofenceTrigger)
  geo.stop()
  socket.disconnect()
})
</script>

<style scoped>
.driver-app {
  min-height: 100vh;
  padding-top: calc(52px + env(safe-area-inset-top, 0px));
  padding-bottom: calc(80px + env(safe-area-inset-bottom, 0px));
  font-size: 0.95rem;
}

/* Onboarding Lock Screen */
.onboarding-locked {
  padding: 0.75rem;
  display: flex;
  flex-direction: column;
  gap: 0.5rem;
}
.ob-welcome {
  text-align: center;
  padding: 1.5rem 1rem 0.5rem;
}
.ob-welcome-icon { font-size: 2.2rem; }
.ob-welcome-title { font-size: 1.2rem; font-weight: 800; margin-top: 0.25rem; }
.ob-welcome-sub { font-size: 0.82rem; color: var(--text-dim); margin-top: 0.2rem; }
.ob-progress-card { padding: 1rem; }
.ob-progress-header { display: flex; justify-content: space-between; margin-bottom: 0.4rem; }
.ob-progress-label { font-weight: 700; font-size: 0.88rem; }
.ob-progress-pct { font-weight: 700; font-size: 0.88rem; color: var(--accent); }
.ob-bar-track { height: 10px; border-radius: 5px; background: var(--bg); overflow: hidden; }
.ob-bar-fill { height: 100%; border-radius: 5px; background: var(--accent); transition: width 0.4s ease; }
.ob-step { padding: 1rem; }
.ob-step-header { display: flex; align-items: center; gap: 0.75rem; }
.ob-step-num {
  width: 32px; height: 32px; border-radius: 50%;
  display: flex; align-items: center; justify-content: center;
  font-weight: 800; font-size: 0.85rem; flex-shrink: 0;
}
.ob-done { background: #d1fae5; color: #065f46; }
.ob-active { background: #dbeafe; color: #1e40af; }
.ob-pending { background: #f3f4f6; color: #9ca3af; }
.ob-step-info { flex: 1; }
.ob-step-title { font-weight: 700; font-size: 0.92rem; }
.ob-step-sub { font-size: 0.75rem; color: var(--text-dim); margin-top: 0.1rem; }
.ob-doc-list { margin-top: 0.75rem; display: flex; flex-direction: column; gap: 0.25rem; }
.ob-doc-item {
  display: flex; align-items: center; gap: 0.6rem;
  padding: 0.55rem 0.5rem; border-radius: 8px; cursor: pointer;
  transition: background 0.15s;
}
.ob-doc-item:active { background: var(--bg); }
.ob-doc-icon { font-size: 1.1rem; flex-shrink: 0; }
.ob-doc-name { flex: 1; font-size: 0.82rem; font-weight: 500; }
.ob-doc-action {
  font-size: 0.72rem; font-weight: 700; color: var(--accent);
  padding: 0.2rem 0.6rem; border-radius: 99px; background: var(--accent-dim);
}
.ob-next-steps {
  margin-top: 1rem; padding: 1rem; background: #f0fdf4; border-radius: 10px;
  border: 1px solid #bbf7d0; font-size: 0.82rem; line-height: 1.6;
}
.ob-next-title {
  font-weight: 800; font-size: 0.95rem; color: #065f46; margin-bottom: 0.5rem;
}
.ob-next-steps ul { margin: 0.5rem 0; padding-left: 1.2rem; }
.ob-next-steps li { margin-bottom: 0.4rem; }
.ob-next-steps p { margin-bottom: 0.4rem; }

/* Welcome / Activation Modal */
.welcome-overlay {
  position: fixed;
  inset: 0;
  background: rgba(15, 23, 42, 0.78);
  backdrop-filter: blur(4px);
  -webkit-backdrop-filter: blur(4px);
  display: flex;
  align-items: center;
  justify-content: center;
  z-index: 500;
  padding: 1rem;
  animation: welcome-fade 0.3s ease-out;
}
@keyframes welcome-fade {
  from { opacity: 0; }
  to { opacity: 1; }
}
.welcome-card {
  background: linear-gradient(160deg, #ffffff 0%, #f0fdf4 100%);
  border-radius: 20px;
  padding: 2rem 1.75rem 1.75rem;
  max-width: 380px;
  width: 100%;
  box-shadow: 0 24px 80px rgba(0, 0, 0, 0.4), 0 0 0 1px rgba(16, 185, 129, 0.2);
  text-align: center;
  animation: welcome-pop 0.4s cubic-bezier(0.34, 1.56, 0.64, 1);
}
@keyframes welcome-pop {
  from { transform: scale(0.85); opacity: 0; }
  to { transform: scale(1); opacity: 1; }
}
.welcome-icon {
  font-size: 3.5rem;
  line-height: 1;
  margin-bottom: 0.6rem;
}
.welcome-title {
  font-size: 1.5rem;
  font-weight: 800;
  color: #064e3b;
  margin: 0 0 0.5rem;
  letter-spacing: -0.01em;
}
.welcome-sub {
  font-size: 0.95rem;
  color: #374151;
  margin: 0 0 1.25rem;
}
.welcome-sub b { color: #065f46; }
.welcome-checklist {
  background: #ecfdf5;
  border: 1px solid #a7f3d0;
  border-radius: 12px;
  padding: 0.85rem 1rem;
  margin-bottom: 1rem;
  text-align: left;
}
.welcome-check {
  font-size: 0.85rem;
  color: #065f46;
  display: flex;
  align-items: center;
  gap: 0.55rem;
  padding: 0.22rem 0;
  font-weight: 600;
}
.wc-icon {
  font-size: 0.9rem;
  flex-shrink: 0;
}
.welcome-msg {
  font-size: 0.85rem;
  color: #4b5563;
  line-height: 1.55;
  margin: 0 0 0.4rem;
}
.welcome-signoff {
  font-size: 0.8rem;
  color: #6b7280;
  font-style: italic;
  margin: 0 0 1.3rem;
}
.welcome-btn {
  display: block;
  width: 100%;
  background: linear-gradient(135deg, #059669, #10b981);
  color: #ffffff;
  border: none;
  border-radius: 10px;
  padding: 0.9rem 1.25rem;
  font-size: 0.95rem;
  font-weight: 700;
  cursor: pointer;
  transition: transform 0.12s, box-shadow 0.12s;
  box-shadow: 0 4px 14px rgba(16, 185, 129, 0.4);
  font-family: inherit;
}
.welcome-btn:hover {
  transform: translateY(-1px);
  box-shadow: 0 6px 18px rgba(16, 185, 129, 0.5);
}
.welcome-btn:active { transform: translateY(0); }

/* Distance Warning Banner */
.distance-warning {
  position: fixed;
  top: calc(52px + env(safe-area-inset-top, 0px));
  left: 0;
  right: 0;
  z-index: 150;
  display: flex;
  align-items: center;
  gap: 0.65rem;
  padding: 0.75rem 1rem;
  background: #fef2f2;
  border-bottom: 2px solid #fca5a5;
  color: #991b1b;
  animation: slideDown 0.3s ease-out;
}
@keyframes slideDown {
  from { transform: translateY(-100%); }
  to { transform: translateY(0); }
}
.warning-icon {
  font-size: 1.3rem;
  flex-shrink: 0;
}
.warning-content {
  flex: 1;
  min-width: 0;
}
.warning-title {
  font-weight: 700;
  font-size: 0.82rem;
}
.warning-message {
  font-size: 0.75rem;
  color: #b91c1c;
  margin-top: 0.1rem;
}
.warning-dismiss {
  border: none;
  background: none;
  font-size: 1.2rem;
  color: #991b1b;
  cursor: pointer;
  padding: 0.25rem;
  flex-shrink: 0;
  opacity: 0.6;
}
.warning-dismiss:hover {
  opacity: 1;
}

.app-content {
  padding: 0.75rem 0.5rem;
  padding-bottom: 1rem;
}

.tab-panel {
  /* v-show handles visibility */
}

/* Sub-tab bar */
.load-sub-tabs {
  display: flex;
  gap: 0.35rem;
  margin-bottom: 0.75rem;
  background: var(--bg);
  border-radius: var(--radius);
  padding: 0.25rem;
}

.sub-tab {
  flex: 1;
  padding: 0.55rem 0;
  font-size: 0.78rem;
  font-family: inherit;
  font-weight: 600;
  border: none;
  border-radius: 6px;
  background: transparent;
  color: var(--text-dim);
  cursor: pointer;
  transition: all 0.15s;
  text-align: center;
  display: flex;
  align-items: center;
  justify-content: center;
  gap: 0.3rem;
}

.sub-tab.active {
  background: var(--surface);
  color: var(--accent);
  box-shadow: 0 1px 3px rgba(0, 0, 0, 0.08);
}

.sub-tab-count {
  font-family: 'JetBrains Mono', monospace;
  font-size: 0.65rem;
  background: var(--border);
  padding: 0.05rem 0.35rem;
  border-radius: 10px;
  color: var(--text-dim);
}

.sub-tab.active .sub-tab-count {
  background: var(--accent-dim);
  color: var(--accent);
}

/* Section headers */
.section-header {
  font-size: 0.95rem;
  font-weight: 600;
  margin-bottom: 0.75rem;
  display: flex;
  align-items: center;
  gap: 0.5rem;
}

.section-count {
  font-family: 'JetBrains Mono', monospace;
  font-size: 0.7rem;
  background: var(--bg);
  border: 1px solid var(--border);
  padding: 0.1rem 0.5rem;
  border-radius: 20px;
  color: var(--text-dim);
}

/* Load selector */
.status-load-header {
  display: flex;
  align-items: center;
  justify-content: space-between;
  padding: 0.6rem 0.75rem;
  background: var(--surface);
  border: 1px solid var(--border);
  border-radius: var(--radius);
  margin-bottom: 1rem;
}
.status-load-id {
  font-family: 'JetBrains Mono', monospace;
  font-size: 0.9rem;
  font-weight: 700;
}
.status-section-divider {
  font-size: 0.75rem;
  font-weight: 700;
  text-transform: uppercase;
  letter-spacing: 0.05em;
  color: var(--text-dim);
  margin-top: 1.25rem;
  margin-bottom: 0.5rem;
  padding-left: 0.1rem;
}

.load-selector {
  width: 100%;
  padding: 0.6rem 0.75rem;
  border: 1px solid var(--border);
  border-radius: var(--radius);
  font-family: inherit;
  font-size: 0.85rem;
  background: var(--surface);
  color: var(--text);
  margin-bottom: 1rem;
  cursor: pointer;
}

/* Empty state icons */
.empty-icon {
  font-size: 2rem;
  margin-bottom: 0.5rem;
}

/* Filter toggle button */
.filter-toggle {
  margin-left: auto;
  padding: 0.25rem 0.6rem;
  font-size: 0.7rem;
  font-family: inherit;
  font-weight: 500;
  border: 1px solid var(--border);
  border-radius: 6px;
  background: var(--surface);
  color: var(--text-dim);
  cursor: pointer;
  transition: all 0.15s;
}

.filter-toggle.active {
  background: var(--accent-dim);
  color: var(--accent);
  border-color: var(--accent);
}

/* Filter panel */
.load-filters {
  background: var(--surface);
  border: 1px solid var(--border);
  border-radius: var(--radius);
  padding: 0.75rem;
  margin-bottom: 0.75rem;
}

.filter-row {
  margin-bottom: 0.5rem;
}

.filter-row:last-child {
  margin-bottom: 0;
}


.filter-input {
  width: 100%;
  padding: 0.45rem 0.65rem;
  border: 1px solid var(--border);
  border-radius: 6px;
  font-family: inherit;
  font-size: 0.8rem;
  background: var(--bg);
  color: var(--text);
  box-sizing: border-box;
}

.filter-input:focus {
  outline: none;
  border-color: var(--accent);
}

.filter-input::placeholder {
  color: var(--text-dim);
}

.date-row {
  display: flex;
  gap: 0.5rem;
}

.date-row .filter-group {
  flex: 1;
}

.filter-label {
  display: block;
  font-size: 0.65rem;
  font-weight: 600;
  color: var(--text-dim);
  text-transform: uppercase;
  letter-spacing: 0.04em;
  margin-bottom: 0.2rem;
}

.clear-filters {
  width: 100%;
  margin-top: 0.5rem;
  padding: 0.35rem;
  font-size: 0.72rem;
  font-family: inherit;
  font-weight: 500;
  border: none;
  border-radius: 6px;
  background: var(--bg);
  color: var(--text-dim);
  cursor: pointer;
  transition: all 0.15s;
}

.clear-filters:hover {
  color: var(--danger);
}

/* Skeleton loading */
.skeleton {
  background: linear-gradient(90deg, var(--bg) 25%, var(--surface-hover) 50%, var(--bg) 75%);
  background-size: 200% 100%;
  animation: shimmer 1.5s infinite;
  border-radius: var(--radius);
}

.skeleton-card {
  height: 140px;
  margin-bottom: 0.75rem;
}

@keyframes shimmer {
  0% { background-position: 200% 0; }
  100% { background-position: -200% 0; }
}

/* Toast position override for bottom nav */
:deep(.toast-container) {
  bottom: 80px;
}

/* Decline confirmation overlay */
.confirm-overlay {
  position: fixed;
  inset: 0;
  background: rgba(0,0,0,0.4);
  display: flex;
  align-items: center;
  justify-content: center;
  z-index: 1000;
  padding: 1rem;
}
.confirm-dialog {
  background: var(--surface, #fff);
  border-radius: 14px;
  padding: 1.5rem;
  max-width: 320px;
  width: 100%;
}
.confirm-title {
  font-weight: 700;
  font-size: 1rem;
  margin-bottom: 0.5rem;
}
.confirm-msg {
  font-size: 0.85rem;
  color: var(--text-dim);
  margin-bottom: 1.25rem;
  line-height: 1.4;
}
.confirm-actions {
  display: flex;
  gap: 0.5rem;
}
.confirm-btn {
  flex: 1;
  padding: 0.6rem;
  border-radius: 8px;
  font-family: inherit;
  font-size: 0.85rem;
  font-weight: 600;
  cursor: pointer;
}
.confirm-btn.cancel {
  background: var(--bg);
  color: var(--text);
  border: 1px solid var(--border);
}
.confirm-btn.danger {
  background: var(--danger, #ef4444);
  color: #fff;
  border: none;
}

/* Location permission lock — mirrors the onboarding lock layout so the two
   gate screens feel like siblings. */
.location-locked {
  max-width: 520px;
  margin: 0 auto;
  padding-bottom: 2rem;
}
.loc-card {
  text-align: center;
  padding: 1.5rem 1.25rem;
}
.loc-icon {
  font-size: 2.6rem;
  line-height: 1;
  margin-bottom: 0.6rem;
}
.loc-title {
  font-size: 1.15rem;
  font-weight: 800;
  margin-bottom: 0.4rem;
}
.loc-sub {
  font-size: 0.88rem;
  color: var(--text-dim);
  line-height: 1.45;
  margin-bottom: 1rem;
}
.loc-status {
  font-size: 0.82rem;
  color: var(--text-dim);
  font-style: italic;
  padding: 0.75rem 0;
}
.loc-guide {
  text-align: left;
  background: var(--bg);
  border: 1px solid var(--border);
  border-radius: 10px;
  padding: 0.85rem 1rem;
  font-size: 0.82rem;
  color: var(--text);
  margin-bottom: 1rem;
  line-height: 1.5;
}
.loc-guide p { margin: 0 0 0.5rem; }
.loc-guide ul { margin: 0.25rem 0 0; padding-left: 1.1rem; }
.loc-guide li { margin-bottom: 0.35rem; }
.loc-btn {
  display: block;
  width: 100%;
  padding: 0.85rem 1rem;
  background: var(--accent, #10b981);
  color: #fff;
  border: none;
  border-radius: 10px;
  font-size: 0.95rem;
  font-weight: 700;
  cursor: pointer;
  margin-bottom: 0.6rem;
  transition: opacity 0.15s;
  font-family: inherit;
}
.loc-btn:disabled { opacity: 0.6; cursor: not-allowed; }
.loc-btn:hover:not(:disabled) { opacity: 0.9; }
.loc-btn-sub {
  display: block;
  width: 100%;
  padding: 0.65rem 1rem;
  background: transparent;
  color: var(--text-dim);
  border: 1px solid var(--border);
  border-radius: 10px;
  font-size: 0.82rem;
  font-weight: 600;
  cursor: pointer;
  font-family: inherit;
}
.loc-btn-sub:hover { background: var(--bg); }

/* Full-screen receipt preview overlay — same pattern used on admin /expenses */
.receipt-preview-overlay {
  position: fixed;
  inset: 0;
  background: rgba(0, 0, 0, 0.85);
  display: flex;
  align-items: center;
  justify-content: center;
  z-index: 300;
  cursor: zoom-out;
  padding: 1rem;
}
.receipt-preview-img {
  max-width: 95vw;
  max-height: 90vh;
  border-radius: 8px;
  box-shadow: 0 10px 40px rgba(0, 0, 0, 0.4);
}
</style>
