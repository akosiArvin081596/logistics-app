<template>
  <div class="driver-app">
    <!-- Header -->
    <DriverHeader
      :driver-name="driverName"
      @refresh="handleRefresh"
      @logout="handleLogout"
    />

    <!-- Main content area -->
    <main class="app-content">
      <!-- LOADS TAB -->
      <section v-show="currentTab === 'loads'" class="tab-panel">
        <div class="section-header">
          My Loads
          <span class="section-count">{{ driverStore.sortedLoads.length }}</span>
        </div>
        <template v-if="driverStore.isLoading">
          <div class="skeleton skeleton-card"></div>
          <div class="skeleton skeleton-card"></div>
        </template>
        <template v-else-if="driverStore.sortedLoads.length === 0">
          <EmptyState>
            <div class="empty-icon">&#128230;</div>
            No loads assigned.<br>Check back later.
          </EmptyState>
        </template>
        <template v-else>
          <LoadCard
            v-for="load in driverStore.sortedLoads"
            :key="load._rowIndex"
            :load="load"
            :headers="driverStore.headers.jobTracking"
            @select="handleLoadSelect"
            @chat="handleLoadChat"
          />
        </template>
      </section>

      <!-- STATUS TAB -->
      <section v-show="currentTab === 'status'" class="tab-panel">
        <div class="section-header">Status Update</div>
        <template v-if="driverStore.activeLoads.length === 0">
          <EmptyState>
            <div class="empty-icon">&#128666;</div>
            No active loads to update.
          </EmptyState>
        </template>
        <template v-else>
          <!-- Load selector for multiple active loads -->
          <select
            v-if="driverStore.activeLoads.length > 1"
            v-model="selectedStatusRowIndex"
            class="load-selector"
            @change="onStatusLoadChange"
          >
            <option
              v-for="l in driverStore.activeLoads"
              :key="l._rowIndex"
              :value="l._rowIndex"
            >{{ getLoadId(l) }}</option>
          </select>

          <StatusStepper
            v-if="selectedLoad"
            :load="selectedLoad"
            :headers="driverStore.headers.jobTracking"
            :current-status="getLoadStatus(selectedLoad)"
            @update="handleStatusUpdate"
          />

          <DocumentUpload
            v-if="selectedLoad && /^delivered$/i.test(getLoadStatus(selectedLoad))"
            :load-id="getLoadId(selectedLoad)"
            :driver-name="driverName"
            :row-index="selectedLoad._rowIndex"
            @uploaded="handleRefresh"
          />
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

      <!-- MESSAGES TAB -->
      <section v-show="currentTab === 'messages'" class="tab-panel">
        <ChatView
          :messages="driverStore.messages"
          :loads="driverStore.loads"
          :driver-name="driverName"
          :load-id="chatLoadId"
          @send="handleSendMessage"
          @mark-read="handleMarkRead"
          @change-load="handleChatLoadChange"
        />
      </section>

      <!-- EXPENSES TAB -->
      <section v-show="currentTab === 'expenses'" class="tab-panel">
        <div class="section-header">Expenses</div>

        <ExpenseForm
          :loads="driverStore.loads"
          :driver-name="driverName"
          :headers="driverStore.headers.jobTracking"
          @submit="handleExpenseSubmit"
        />

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
      @switch="handleTabSwitch"
    />
  </div>
</template>

<script setup>
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
import StatusStepper from '../components/driver/StatusStepper.vue'
import ChatView from '../components/driver/ChatView.vue'
import ExpenseForm from '../components/driver/ExpenseForm.vue'
import ExpenseCard from '../components/driver/ExpenseCard.vue'
import DriverKit from '../components/driver/DriverKit.vue'
import DocumentUpload from '../components/driver/DocumentUpload.vue'
import EmptyState from '../components/shared/EmptyState.vue'

const auth = useAuthStore()
const driverStore = useDriverStore()
const socket = useSocket()
const toast = useToast()
const router = useRouter()
const geo = useGeolocation(useApi())

const currentTab = ref('loads')
const selectedStatusRowIndex = ref(null)
const chatLoadId = ref('')
let refreshInterval = null

const driverName = computed(() => auth.user?.driverName || auth.user?.username || '')

// Selected load for status tab
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

// Load select on loads tab
function handleLoadSelect(load) {
  selectedStatusRowIndex.value = load._rowIndex
  currentTab.value = 'status'
  driverStore.currentTab = 'status'
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
  const headers = driverStore.headers.jobTracking
  const loadIdCol = findCol(headers, /load.?id|job.?id/i)
  const loadId = loadIdCol ? load[loadIdCol] : ''

  try {
    await driverStore.updateStatus(loadId, newStatus, load._rowIndex, headers)
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
  toast.show(`New load assigned: ${payload.loadId || 'Load'}`)
  driverStore.loadData()
}

function onGeofenceTrigger(payload) {
  toast.show(`Geofence: ${payload.status} for Load ${payload.loadId}`)
}

function onNewMessage(msg) {
  const myName = driverName.value.toLowerCase()
  const from = (msg.from || '').toLowerCase()
  const to = (msg.to || '').toLowerCase()

  if (from === myName || to === myName) {
    // Skip own sends (already added optimistically)
    if (from === myName) return

    driverStore.addIncomingMessage(msg)

    if (currentTab.value !== 'messages') {
      toast.show('New message from ' + msg.from)
    }
  }
}

// Start/stop GPS tracking based on active loads
watch(
  () => driverStore.activeLoads,
  (active) => {
    if (active.length > 0) {
      const firstLoadId = getLoadId(active[0])
      if (!geo.tracking.value) {
        geo.start(firstLoadId)
      } else {
        geo.updateLoadId(firstLoadId)
      }
    } else {
      geo.stop()
    }
  }
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

  // Auto-refresh every 30 seconds
  refreshInterval = setInterval(async () => {
    try {
      await driverStore.loadData()
    } catch {
      // silent refresh failure
    }
  }, 30000)

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
  padding-bottom: 68px;
  font-size: 0.95rem;
}

.app-content {
  padding: 1rem;
}

.tab-panel {
  /* v-show handles visibility */
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
</style>
