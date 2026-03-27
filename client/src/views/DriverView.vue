<template>
  <div class="driver-app">
    <!-- Load Assigned Notification -->
    <LoadAssignedBanner
      :notification="assignedNotification"
      @dismiss="dismissAssignedBanner"
      @view-load="viewAssignedLoad"
    />

    <!-- Distance Warning Banner -->
    <div v-if="geo.distanceWarning.value" class="distance-warning">
      <div class="warning-icon">&#9888;</div>
      <div class="warning-content">
        <div class="warning-title">
          {{ geo.distanceWarning.value.type === 'far-from-pickup' ? 'Far from Pickup' : 'Far from Delivery' }}
        </div>
        <div class="warning-message">{{ geo.distanceWarning.value.message }}</div>
      </div>
      <button class="warning-dismiss" @click="geo.distanceWarning.value = null">&times;</button>
    </div>

    <!-- Header -->
    <DriverHeader
      :driver-name="driverName"
      @logout="handleLogout"
    />

    <!-- Main content area -->
    <main class="app-content">
      <!-- LOADS TAB -->
      <section v-show="currentTab === 'loads'" class="tab-panel">
        <!-- Load Detail Page -->
        <LoadDetail
          v-if="detailLoad"
          :load="detailLoad"
          :headers="driverStore.headers.jobTracking"
          :driver-name="driverName"
          :has-active-job="driverStore.hasActiveJob"
          :driver-position="geo.lastPosition.value"
          @back="detailRowIndex = null"
          @status-update="handleStatusUpdate"
          @uploaded="handleRefresh"
        />

        <!-- Load List -->
        <template v-else>
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

          <template v-if="driverStore.isLoading">
            <div class="skeleton skeleton-card"></div>
            <div class="skeleton skeleton-card"></div>
          </template>
          <template v-else-if="driverStore.filteredLoads.length === 0">
            <EmptyState>
              <div class="empty-icon">&#128230;</div>
              <template v-if="driverStore.loads.length > 0">
                No loads in this category.
              </template>
              <template v-else>
                No loads assigned.<br>Check back later.
              </template>
            </EmptyState>
          </template>
          <template v-else>
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
          </template>
        </template>
      </section>

      <!-- STATUS TAB -->
      <section v-show="currentTab === 'status'" class="tab-panel">
        <div class="section-header">Status Update</div>
        <template v-if="!currentActiveLoad">
          <EmptyState>
            <div class="empty-icon">&#128666;</div>
            No active loads to update.
          </EmptyState>
        </template>
        <template v-else>
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
        </template>
      </section>

      <!-- KIT TAB -->
      <section v-show="currentTab === 'kit'" class="tab-panel">
        <div class="section-header">Driver Kit</div>
        <template v-if="driverStore.isLoading">
          <div class="skeleton skeleton-card"></div>
        </template>
        <template v-else>
          <DriverKit
            :driver-info="driverStore.driverInfo"
            :headers="driverStore.headers.carrierDB"
          />
        </template>
      </section>

      <!-- NOTIFICATIONS TAB -->
      <section v-show="currentTab === 'notifications'" class="tab-panel">
        <NotificationList
          :notifications="driverStore.notifications"
          @tap="handleNotificationTap"
          @mark-all-read="handleMarkAllNotifRead"
        />
      </section>

      <!-- MESSAGES TAB -->
      <section v-show="currentTab === 'messages'" class="tab-panel">
        <ChatView
          :messages="driverStore.messages"
          :loads="driverStore.loads"
          :driver-name="driverName"
          @send="handleSendMessage"
          @mark-read="handleMarkRead"
        />
      </section>

      <!-- EXPENSES TAB -->
      <section v-show="currentTab === 'expenses'" class="tab-panel">
        <div class="section-header">Expenses</div>

        <template v-if="driverStore.workingLoads.length > 0">
          <ExpenseForm
            :loads="driverStore.workingLoads"
            :driver-name="driverName"
            :headers="driverStore.headers.jobTracking"
            @submit="handleExpenseSubmit"
          />
        </template>
        <EmptyState v-else>
          No active loads.
        </EmptyState>

        <div class="section-header" style="margin-top: 1rem;">
          History
          <span class="section-count">{{ driverStore.expenses.length }}</span>
        </div>

        <template v-if="driverStore.expenses.length === 0">
          <EmptyState>
            <div class="empty-icon">&#128176;</div>
            No expenses logged yet.
          </EmptyState>
        </template>
        <template v-else>
          <ExpenseCard
            v-for="(exp, i) in driverStore.expenses"
            :key="exp.id || i"
            :expense="exp"
          />
        </template>
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
import EmptyState from '../components/shared/EmptyState.vue'
import StatusBadge from '../components/shared/StatusBadge.vue'

const auth = useAuthStore()
const driverStore = useDriverStore()
const socket = useSocket()
const toast = useToast()
const router = useRouter()
const geo = useGeolocation(useApi())

const currentTab = ref('loads')
const selectedStatusRowIndex = ref(null)
const chatLoadId = ref('')
const showFilters = ref(false)
const detailRowIndex = ref(null)
const assignedNotification = ref(null)
let refreshInterval = null

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
const detailLoad = computed(() => {
  if (!detailRowIndex.value) return null
  return driverStore.loads.find(l => l._rowIndex === detailRowIndex.value) || null
})

// Current active load for status tab (only working loads — not pending/delivered)
const currentActiveLoad = computed(() => {
  return driverStore.workingLoads[0] || null
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
  if (refreshInterval) clearInterval(refreshInterval)
  socket.disconnect()
  await auth.logout()
  router.push('/login')
}

async function handleStatusUpdate({ newStatus, load }) {
  const loadIdCol = findCol(driverStore.headers.jobTracking, /load.?id|job.?id/i)
  const loadId = loadIdCol ? load[loadIdCol] : ''

  try {
    await driverStore.updateStatus(loadId, newStatus, load._rowIndex)
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

function onGeofenceTrigger(payload) {
  toast.show(`Geofence: ${payload.status} for Load ${payload.loadId}`)
  driverStore.addNotification({
    id: Date.now(),
    type: 'geofence',
    title: `Geofence: ${payload.status}`,
    body: `Load ${payload.loadId}`,
    metadata: JSON.stringify(payload),
    read: 0,
    createdAt: new Date().toISOString(),
  })
}

function onNewMessage(msg) {
  const myName = driverName.value.toLowerCase()
  const from = (msg.from || '').toLowerCase()
  const to = (msg.to || '').toLowerCase()

  if (from === myName || to === myName) {
    // Skip own sends (already added optimistically)
    if (from === myName) return

    driverStore.addIncomingMessage(msg)
    driverStore.addNotification({
      id: Date.now(),
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

onMounted(async () => {
  driverStore.driverName = driverName.value
  try {
    await driverStore.loadData()
  } catch {
    toast.show('Failed to load data', 'error')
  }


  // Socket.IO
  socket.connect()
  socket.register(driverName.value)
  socket.on('new-message', onNewMessage)
  socket.on('load-assigned', onLoadAssigned)
  socket.on('geofence-trigger', onGeofenceTrigger)
})

onUnmounted(() => {
  if (refreshInterval) clearInterval(refreshInterval)
  socket.off('new-message', onNewMessage)
  socket.off('load-assigned', onLoadAssigned)
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
</style>
