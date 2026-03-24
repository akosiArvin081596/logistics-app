<template>
  <div class="dashboard admin-page">
    <div class="page-header">
      <h2>Operations Dashboard</h2>
      <div class="status-bar">
        <span class="status-pill">{{ lastUpdated }}</span>
        <button class="btn btn-secondary btn-sm" @click="refresh">Refresh</button>
      </div>
    </div>

    <!-- KPI Cards -->
    <template v-if="store.kpis">
      <KpiGrid :kpis="store.kpis" />
      <RevenueGrid :revenue="store.revenue" />
    </template>
    <template v-else>
      <div class="kpi-grid">
        <div v-for="n in 4" :key="n" class="kpi-card">
          <div class="skeleton skeleton-line" style="width:50%"></div>
          <div class="skeleton skeleton-line lg"></div>
          <div class="skeleton skeleton-line sm"></div>
        </div>
      </div>
      <div class="revenue-grid">
        <div v-for="n in 3" :key="n" class="revenue-card">
          <div class="skeleton skeleton-line" style="width:50%"></div>
          <div class="skeleton skeleton-line lg"></div>
        </div>
      </div>
    </template>

    <!-- Tabbed Section -->
    <div class="dash-section fill">
      <div class="tab-bar">
        <button :class="['tab-btn', { active: activeTab === 'jobBoard' }]" @click="activeTab = 'jobBoard'">
          Job Board <span class="count-badge danger">{{ store.unassignedJobs.length }}</span>
        </button>
        <button :class="['tab-btn', { active: activeTab === 'activeLoads' }]" @click="activeTab = 'activeLoads'">
          Active Loads <span class="count-badge">{{ store.activeJobs.length }}</span>
        </button>
        <button :class="['tab-btn', { active: activeTab === 'fleet' }]" @click="activeTab = 'fleet'">
          Fleet & Drivers <span class="count-badge" style="background:var(--blue-dim);color:var(--blue)">{{ store.fleet.length }}</span>
        </button>
        <button :class="['tab-btn', { active: activeTab === 'tracking' }]" @click="activeTab = 'tracking'">
          Tracking
        </button>
        <button :class="['tab-btn', { active: activeTab === 'expenses' }]" @click="activeTab = 'expenses'">
          Expenses
        </button>
        <button :class="['tab-btn', { active: activeTab === 'messages' }]" @click="switchToMessages">
          Messages
          <span v-if="msgStore.totalUnread > 0" class="count-badge danger">{{ msgStore.totalUnread }}</span>
        </button>
      </div>

      <div v-show="activeTab === 'jobBoard'" class="tab-panel active">
        <JobBoardTab
          :jobs="store.unassignedJobs"
          :drivers="store.drivers"
          :headers="store.headers"
          :loading="store.isLoading"
          @assign="handleAssign"
        />
      </div>
      <div v-show="activeTab === 'activeLoads'" class="tab-panel active">
        <ActiveLoadsTab :jobs="store.activeJobs" :headers="store.headers" />
      </div>
      <div v-show="activeTab === 'fleet'" class="tab-panel active">
        <FleetTab :fleet="store.fleet" />
      </div>
      <div v-show="activeTab === 'tracking'" class="tab-panel active">
        <TrackingMap :visible="activeTab === 'tracking'" />
      </div>
      <div v-if="activeTab === 'expenses'" class="tab-panel active">
        <ExpensesTab />
      </div>
      <div v-show="activeTab === 'messages'" class="tab-panel active">
        <MessagingPanel :driver-names="driverNames" />
      </div>
    </div>
  </div>
</template>

<script setup>
import { ref, computed, onMounted, onUnmounted } from 'vue'
import { useDashboardStore } from '../stores/dashboard'
import { useMessagesStore } from '../stores/messages'
import { useSocket } from '../composables/useSocket'
import { useToast } from '../composables/useToast'
import KpiGrid from '../components/dashboard/KpiGrid.vue'
import RevenueGrid from '../components/dashboard/RevenueGrid.vue'
import JobBoardTab from '../components/dashboard/JobBoardTab.vue'
import ActiveLoadsTab from '../components/dashboard/ActiveLoadsTab.vue'
import FleetTab from '../components/dashboard/FleetTab.vue'
import MessagingPanel from '../components/dashboard/MessagingPanel.vue'
import TrackingMap from '../components/dashboard/TrackingMap.vue'
import ExpensesTab from '../components/dashboard/ExpensesTab.vue'

const store = useDashboardStore()
const msgStore = useMessagesStore()
const { show: toast } = useToast()
const socket = useSocket()

const activeTab = ref('jobBoard')
let refreshInterval = null

const lastUpdated = computed(() => {
  if (!store.timestamp) return 'Loading...'
  return 'Updated ' + new Date(store.timestamp).toLocaleTimeString()
})

const driverNames = computed(() =>
  store.fleet.map((f) => f.Driver || '').filter(Boolean)
)

async function refresh() {
  try {
    await store.refresh()
  } catch {
    toast('Failed to load dashboard', 'error')
  }
}

async function handleAssign({ rowIndex, driver, job }) {
  try {
    await store.assignDriver(rowIndex, driver, job, store.headers)
    const loadIdCol = store.headers.find((h) => /load.?id|job.?id/i.test(h))
    toast(`${driver} assigned to ${loadIdCol ? job[loadIdCol] : 'load'}`, 'success')
    refresh()
  } catch {
    toast('Failed to assign driver', 'error')
  }
}

function switchToMessages() {
  activeTab.value = 'messages'
  msgStore.loadConversations()
}

function onStatusUpdated(payload) {
  toast(`${payload.driverName}: ${payload.newStatus} — Load ${payload.loadId}`, 'info')
  refresh()
}

function onPodUploaded(payload) {
  toast(`POD uploaded for Load ${payload.loadId} by ${payload.driverName}`, 'success')
  refresh()
}

function onNewMessage(msg) {
  msgStore.addIncomingMessage(msg)
}

onMounted(() => {
  refresh()
  msgStore.loadConversations()

  socket.connect()
  socket.register('dispatch')
  socket.on('new-message', onNewMessage)
  socket.on('status-updated', onStatusUpdated)
  socket.on('pod-uploaded', onPodUploaded)

  refreshInterval = setInterval(refresh, 60000)
})

onUnmounted(() => {
  clearInterval(refreshInterval)
  socket.off('new-message', onNewMessage)
  socket.off('status-updated', onStatusUpdated)
  socket.off('pod-uploaded', onPodUploaded)
})
</script>

<style scoped>
.dashboard { overflow: hidden; }
.kpi-grid, .revenue-grid, .page-header { flex-shrink: 0; }

/* skeleton fallback grids */
.kpi-grid {
  display: grid;
  grid-template-columns: repeat(4, 1fr);
  gap: 1rem;
  margin-bottom: 1rem;
}
.kpi-card {
  background: var(--surface);
  border: 1px solid var(--border);
  border-radius: var(--radius);
  padding: 1.1rem 1.25rem;
}

.revenue-grid {
  display: grid;
  grid-template-columns: repeat(3, 1fr);
  gap: 1rem;
  margin-bottom: 1rem;
}
.revenue-card {
  background: var(--surface);
  border: 1px solid var(--border);
  border-radius: var(--radius);
  padding: 0.9rem 1.25rem;
}

.dash-section.fill {
  flex: 1;
  display: flex;
  flex-direction: column;
  min-height: 0;
  background: var(--surface);
  border: 1px solid var(--border);
  border-radius: var(--radius);
  box-shadow: 0 1px 3px rgba(0,0,0,0.04);
  overflow: hidden;
}
.tab-bar {
  display: flex; gap: 0;
  border-bottom: 1px solid var(--border);
  flex-shrink: 0;
}
.tab-btn {
  padding: 0.75rem 1.25rem;
  border: none; background: transparent;
  font-family: 'DM Sans', sans-serif;
  font-size: 0.85rem; font-weight: 600;
  color: var(--text-dim);
  cursor: pointer; transition: all 0.15s;
  border-bottom: 2px solid transparent;
  display: flex; align-items: center; gap: 0.4rem;
}
.tab-btn:hover { color: var(--text); background: var(--surface-hover); }
.tab-btn.active { color: var(--accent); border-bottom-color: var(--accent); }
.tab-panel {
  flex: 1;
  display: flex;
  flex-direction: column;
  min-height: 0;
  overflow-y: auto;
}

.count-badge {
  background: var(--accent-dim); color: var(--accent);
  font-family: 'JetBrains Mono', monospace;
  font-size: 0.72rem; padding: 0.15rem 0.5rem;
  border-radius: 10px; font-weight: 600;
}
.count-badge.danger { background: var(--danger-dim); color: var(--danger); }

/* Table styles */
:deep(table) { width: 100%; border-collapse: collapse; }
:deep(thead) { background: var(--surface-hover); }
:deep(th) {
  padding: 0.75rem 1rem; text-align: left;
  font-size: 0.72rem; font-weight: 600;
  text-transform: uppercase; letter-spacing: 0.06em;
  color: var(--text-dim);
  border-bottom: 1px solid var(--border);
  white-space: nowrap;
}
:deep(td) {
  padding: 0.7rem 1rem; font-size: 0.88rem;
  border-bottom: 1px solid var(--border);
}
:deep(tr:last-child td) { border-bottom: none; }
:deep(tr:hover td) { background: var(--surface-hover); }

/* Status badge overrides for dashboard */
:deep(.status-badge.in-transit) { background: var(--blue-dim); color: var(--blue); }
:deep(.status-badge.assigned) { background: var(--accent-dim); color: var(--accent); }
:deep(.status-badge.dispatched) { background: var(--blue-dim); color: var(--blue); }
:deep(.status-badge.delivered) { background: rgba(16,185,129,0.2); color: #059669; }
:deep(.status-badge.unassigned) { background: var(--danger-dim); color: var(--danger); }
:deep(.status-badge.picked-up) { background: var(--amber-dim); color: var(--amber); }

.assign-cell {
  display: flex; align-items: center; gap: 0.4rem;
}
:deep(.assign-cell select) {
  padding: 0.3rem 0.5rem;
  background: var(--bg);
  border: 1px solid var(--border);
  border-radius: 4px;
  color: var(--text);
  font-family: 'DM Sans', sans-serif;
  font-size: 0.82rem;
  outline: none;
  min-width: 120px;
}

.fleet-grid {
  display: grid;
  grid-template-columns: repeat(auto-fit, minmax(240px, 1fr));
  gap: 1rem;
  padding: 1.25rem;
}
.fleet-card {
  border: 1px solid var(--border);
  border-radius: 8px;
  padding: 1rem;
  transition: box-shadow 0.15s;
}
.fleet-card:hover { box-shadow: 0 2px 8px rgba(0,0,0,0.06); }
.fleet-card .driver-name { font-weight: 700; font-size: 0.95rem; margin-bottom: 0.15rem; }
.fleet-card .truck-id { font-family: 'JetBrains Mono', monospace; font-size: 0.78rem; color: var(--text-dim); }
.fleet-card .fleet-meta { margin-top: 0.75rem; display: flex; align-items: center; gap: 0.5rem; flex-wrap: wrap; }
.driver-status { display: inline-block; padding: 0.2rem 0.5rem; border-radius: 12px; font-size: 0.7rem; font-weight: 600; }
.driver-status.on-load { background: var(--blue-dim); color: var(--blue); }
.driver-status.available { background: var(--accent-dim); color: var(--accent); }
.fleet-card .fleet-stat { font-size: 0.75rem; color: var(--text-dim); }
.fleet-card .load-id { font-family: 'JetBrains Mono', monospace; font-size: 0.72rem; color: var(--blue); margin-top: 0.25rem; }

/* Messaging panel styles */
:deep(.msg-layout) {
  display: grid;
  grid-template-columns: 240px 1fr;
  height: 420px;
  border: 1px solid var(--border);
  border-radius: var(--radius);
  overflow: hidden;
}
:deep(.msg-sidebar) {
  border-right: 1px solid var(--border);
  overflow-y: auto;
  background: var(--bg);
}
:deep(.msg-sidebar-header) {
  padding: 0.75rem 1rem;
  font-weight: 600;
  font-size: 0.82rem;
  border-bottom: 1px solid var(--border);
  background: var(--surface);
  display: flex;
  align-items: center;
  justify-content: space-between;
}
:deep(.msg-new-btn) {
  width: 26px; height: 26px;
  border: none;
  background: var(--accent);
  color: #fff;
  border-radius: 50%;
  font-size: 1rem;
  line-height: 1;
  cursor: pointer;
  display: flex;
  align-items: center;
  justify-content: center;
}
:deep(.msg-new-overlay) {
  position: absolute;
  inset: 0;
  background: var(--surface);
  z-index: 10;
  display: flex;
  flex-direction: column;
}
:deep(.msg-new-header) {
  padding: 0.75rem 1rem;
  font-weight: 600;
  font-size: 0.82rem;
  border-bottom: 1px solid var(--border);
  display: flex;
  align-items: center;
  justify-content: space-between;
}
:deep(.msg-new-search) {
  margin: 0.5rem;
  padding: 0.45rem 0.65rem;
  border: 1px solid var(--border);
  border-radius: var(--radius);
  font-family: inherit;
  font-size: 0.8rem;
  outline: none;
}
:deep(.msg-new-item) {
  padding: 0.55rem 1rem;
  cursor: pointer;
  font-size: 0.82rem;
  border-bottom: 1px solid var(--border);
  transition: background 0.1s;
}
:deep(.msg-new-item:hover) { background: var(--surface-hover); }
:deep(.msg-driver-item) {
  display: flex;
  align-items: center;
  justify-content: space-between;
  padding: 0.6rem 1rem;
  cursor: pointer;
  border-bottom: 1px solid var(--border);
  font-size: 0.82rem;
  transition: background 0.1s;
}
:deep(.msg-driver-item:hover) { background: var(--surface-hover); }
:deep(.msg-driver-item.active) { background: var(--accent-dim); color: var(--accent); font-weight: 600; }
:deep(.msg-unread) {
  min-width: 18px; height: 18px;
  background: var(--danger);
  color: #fff;
  font-size: 0.6rem;
  font-weight: 700;
  border-radius: 9px;
  display: flex; align-items: center; justify-content: center;
  padding: 0 5px;
}
:deep(.msg-time) {
  font-size: 0.65rem;
  color: var(--text-dim);
  font-family: 'JetBrains Mono', monospace;
}
:deep(.msg-chat) {
  display: flex;
  flex-direction: column;
  background: var(--surface);
}
:deep(.msg-chat-header) {
  padding: 0.75rem 1rem;
  font-weight: 600;
  font-size: 0.85rem;
  border-bottom: 1px solid var(--border);
}
:deep(.msg-chat-messages) {
  flex: 1;
  overflow-y: auto;
  padding: 0.75rem 1rem;
  display: flex;
  flex-direction: column;
  gap: 0.4rem;
}
:deep(.msg-bubble) {
  max-width: 70%;
  padding: 0.5rem 0.75rem;
  border-radius: 10px;
  font-size: 0.82rem;
  line-height: 1.4;
  word-break: break-word;
}
:deep(.msg-bubble.sent) {
  align-self: flex-end;
  background: var(--accent);
  color: #fff;
  border-bottom-right-radius: 3px;
}
:deep(.msg-bubble.received) {
  align-self: flex-start;
  background: var(--bg);
  border: 1px solid var(--border);
  border-bottom-left-radius: 3px;
}
:deep(.msg-bubble .msg-meta) { font-size: 0.6rem; margin-top: 0.15rem; opacity: 0.7; }
:deep(.msg-bubble .msg-load-tag) {
  font-family: 'JetBrains Mono', monospace;
  font-size: 0.58rem;
  background: rgba(0,0,0,0.08);
  padding: 0.05rem 0.35rem;
  border-radius: 3px;
  margin-bottom: 0.2rem;
  display: inline-block;
}
:deep(.msg-bubble.sent .msg-load-tag) { background: rgba(255,255,255,0.2); }
:deep(.msg-chat-input) {
  display: flex;
  gap: 0.5rem;
  padding: 0.6rem 1rem;
  border-top: 1px solid var(--border);
}
:deep(.msg-input) {
  flex: 1;
  padding: 0.5rem 0.75rem;
  border: 1px solid var(--border);
  border-radius: 18px;
  font-family: inherit;
  font-size: 0.82rem;
  outline: none;
}
:deep(.msg-input:focus) { border-color: var(--accent); }
:deep(.msg-send-btn) {
  width: 36px; height: 36px;
  border-radius: 50%;
  background: var(--accent);
  color: #fff;
  border: none;
  font-size: 0.95rem;
  cursor: pointer;
  display: flex; align-items: center; justify-content: center;
}

.skeleton-line { height: 0.85rem; margin-bottom: 0.4rem; }
.skeleton-line.lg { height: 1.75rem; width: 60%; }
.skeleton-line.sm { height: 0.7rem; width: 40%; }

</style>
