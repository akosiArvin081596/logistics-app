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
      <KpiGrid :kpis="store.kpis" @card-click="handleKpiClick" />
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
        <button :class="['tab-btn', { active: activeTab === 'completed' }]" @click="activeTab = 'completed'">
          Completed <span class="count-badge" style="background:rgba(16,185,129,0.15);color:#059669">{{ store.completedJobs.length }}</span>
        </button>
        <button :class="['tab-btn', { active: activeTab === 'fleet' }]" @click="activeTab = 'fleet'">
          Fleet & Drivers <span class="count-badge" style="background:var(--blue-dim);color:var(--blue)">{{ store.fleet.length }}</span>
        </button>
      </div>

      <div v-show="activeTab === 'jobBoard'" class="tab-panel active">
        <JobBoardTab
          :jobs="store.unassignedJobs"
          :drivers="store.drivers"
          :headers="store.headers"
          :loading="store.isLoading"
          :show-map="activeTab === 'jobBoard' ? mapTrigger : 0"
          @assign="handleAssign"
        />
      </div>
      <div v-show="activeTab === 'activeLoads'" class="tab-panel active">
        <ActiveLoadsTab
          :jobs="store.activeJobs"
          :headers="store.headers"
          :drivers="store.drivers"
          :show-map="activeTab === 'activeLoads' ? mapTrigger : 0"
          @reassign="handleReassign"
          @cancel="handleCancel"
          @status-update="handleStatusUpdate"
        />
      </div>
      <div v-show="activeTab === 'completed'" class="tab-panel active">
        <CompletedLoadsTab
          :jobs="store.completedJobs"
          :headers="store.completedHeaders"
          :show-map="activeTab === 'completed' ? mapTrigger : 0"
        />
      </div>
      <div v-show="activeTab === 'fleet'" class="tab-panel active">
        <FleetTab :fleet="store.fleet" :active-jobs="store.activeJobs" :headers="store.headers" />
      </div>
    </div>
  </div>
</template>

<script setup>
import { ref, computed, onMounted, onUnmounted } from 'vue'
import { useDashboardStore } from '../stores/dashboard'
import { useSocket } from '../composables/useSocket'
import { useToast } from '../composables/useToast'
import KpiGrid from '../components/dashboard/KpiGrid.vue'
import RevenueGrid from '../components/dashboard/RevenueGrid.vue'
import JobBoardTab from '../components/dashboard/JobBoardTab.vue'
import ActiveLoadsTab from '../components/dashboard/ActiveLoadsTab.vue'
import FleetTab from '../components/dashboard/FleetTab.vue'
import CompletedLoadsTab from '../components/dashboard/CompletedLoadsTab.vue'

const store = useDashboardStore()
const { show: toast } = useToast()
const socket = useSocket()

const activeTab = ref('jobBoard')
const mapTrigger = ref(0)
let refreshInterval = null

const lastUpdated = computed(() => {
  if (!store.timestamp) return 'Loading...'
  return 'Updated ' + new Date(store.timestamp).toLocaleTimeString()
})

function handleKpiClick(key) {
  const tabMap = { active: 'activeLoads', unassigned: 'jobBoard', completed: 'completed', fleet: 'fleet' }
  activeTab.value = tabMap[key] || activeTab.value
  if (key !== 'fleet') mapTrigger.value++
}

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

async function handleReassign({ rowIndex, newDriver, job }) {
  try {
    await store.reassignDriver(rowIndex, newDriver, job, store.headers)
    const loadIdCol = store.headers.find((h) => /load.?id|job.?id/i.test(h))
    toast(`Load ${loadIdCol ? job[loadIdCol] : ''} reassigned to ${newDriver}`, 'success')
    refresh()
  } catch {
    toast('Failed to reassign driver', 'error')
  }
}

async function handleCancel({ rowIndex, job }) {
  try {
    await store.cancelLoad(rowIndex, job, store.headers)
    const loadIdCol = store.headers.find((h) => /load.?id|job.?id/i.test(h))
    toast(`Load ${loadIdCol ? job[loadIdCol] : ''} assignment cancelled`, 'success')
    refresh()
  } catch {
    toast('Failed to cancel assignment', 'error')
  }
}

async function handleStatusUpdate({ rowIndex, newStatus, job }) {
  try {
    const loadIdCol = store.headers.find((h) => /load.?id|job.?id/i.test(h))
    const driverCol = store.headers.find((h) => /driver/i.test(h))
    const loadId = loadIdCol ? job[loadIdCol] || '' : ''
    const driverName = driverCol ? job[driverCol] || '' : ''
    await store.updateStatus(rowIndex, driverName, loadId, newStatus)
    toast(`Status updated to ${newStatus}`, 'success')
    refresh()
  } catch {
    toast('Failed to update status', 'error')
  }
}

function onStatusUpdated(payload) {
  toast(`${payload.driverName}: ${payload.newStatus} — Load ${payload.loadId}`, 'info')
  refresh()
}

function onPodUploaded(payload) {
  toast(`POD uploaded for Load ${payload.loadId} by ${payload.driverName}`, 'success')
  refresh()
}

onMounted(() => {
  refresh()

  socket.connect()
  socket.register('dispatch')
  socket.on('status-updated', onStatusUpdated)
  socket.on('pod-uploaded', onPodUploaded)

  refreshInterval = setInterval(refresh, 60000)
})

onUnmounted(() => {
  clearInterval(refreshInterval)
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

:deep(.assign-cell) {
  display: flex; align-items: center; gap: 0.4rem; white-space: nowrap;
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

.skeleton-line { height: 0.85rem; margin-bottom: 0.4rem; }
.skeleton-line.lg { height: 1.75rem; width: 60%; }
.skeleton-line.sm { height: 0.7rem; width: 40%; }

</style>
