<template>
  <div class="dashboard admin-page">
    <div class="page-header">
      <h2>Operations Dashboard</h2>
      <div class="status-bar">
        <span class="status-pill">{{ lastUpdated }}</span>
        <Button label="Refresh" icon="pi pi-refresh" severity="secondary" size="small" @click="refresh" />
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
      <Tabs :value="activeTab" @update:value="activeTab = $event">
        <TabList>
          <Tab value="jobBoard">Job Board <Badge :value="store.unassignedJobs.length" severity="secondary" /></Tab>
          <Tab value="activeLoads">Active Loads <Badge :value="store.activeJobs.length" severity="secondary" /></Tab>
          <Tab value="completed">Completed <Badge :value="store.completedJobs.length" severity="secondary" /></Tab>
          <Tab value="fleet">Fleet & Drivers <Badge :value="store.fleet.length" severity="secondary" /></Tab>
        </TabList>
        <TabPanels>
          <TabPanel value="jobBoard">
            <JobBoardTab
              :jobs="store.unassignedJobs"
              :drivers="store.drivers"
              :headers="store.headers"
              :loading="store.isLoading"
              :show-map="activeTab === 'jobBoard' ? mapTrigger : 0"
              @assign="handleAssign"
            />
          </TabPanel>
          <TabPanel value="activeLoads">
            <ActiveLoadsTab
              :jobs="store.activeJobs"
              :headers="store.headers"
              :drivers="store.drivers"
              :show-map="activeTab === 'activeLoads' ? mapTrigger : 0"
              @reassign="handleReassign"
              @cancel="handleCancel"
              @status-update="handleStatusUpdate"
            />
          </TabPanel>
          <TabPanel value="completed">
            <CompletedLoadsTab
              :jobs="store.completedJobs"
              :headers="store.completedHeaders"
              :show-map="activeTab === 'completed' ? mapTrigger : 0"
            />
          </TabPanel>
          <TabPanel value="fleet">
            <FleetTab :fleet="store.fleet" :active-jobs="store.activeJobs" :headers="store.headers" />
          </TabPanel>
        </TabPanels>
      </Tabs>
    </div>
  </div>
</template>

<script setup>
import { ref, computed, onMounted, onUnmounted } from 'vue'
import Tabs from 'primevue/tabs'
import TabList from 'primevue/tablist'
import Tab from 'primevue/tab'
import TabPanels from 'primevue/tabpanels'
import TabPanel from 'primevue/tabpanel'
import Badge from 'primevue/badge'
import Button from 'primevue/button'
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
/* PrimeVue Tab overrides */
:deep(.p-tabs) { flex: 1; display: flex; flex-direction: column; min-height: 0; }
:deep(.p-tabpanels) { flex: 1; overflow-y: auto; min-height: 0; }
:deep(.p-tabpanel) { padding: 0; }
:deep(.p-tab) { gap: 0.4rem; }

/* PrimeVue DataTable — clean professional look */
:deep(.p-datatable) { font-size: 0.85rem; }
:deep(.p-datatable-header-cell) {
  font-size: 0.7rem !important; font-weight: 600 !important;
  text-transform: uppercase; letter-spacing: 0.05em;
  color: var(--text-dim) !important;
  background: transparent !important;
  border-bottom: 2px solid var(--border) !important;
  padding: 0.7rem 0.85rem !important;
}
:deep(.p-datatable-row-cell) {
  padding: 0.65rem 0.85rem !important;
  border-bottom: 1px solid var(--border) !important;
  background: transparent !important;
}
:deep(.p-datatable-tbody > tr) {
  background: transparent !important;
}
:deep(.p-datatable-tbody > tr:hover) {
  background: rgba(255,255,255,0.03) !important;
}
:deep(.p-datatable-striped .p-datatable-tbody > tr:nth-child(even)) {
  background: transparent !important;
}
:deep(.p-datatable-tbody > tr:last-child > td) {
  border-bottom: none !important;
}

/* PrimeVue Dialog polish */
:deep(.p-dialog) {
  border-radius: 14px;
  box-shadow: 0 20px 60px rgba(0, 0, 0, 0.25);
}
:deep(.p-dialog-header) {
  padding: 1rem 1.25rem;
  font-size: 1rem;
}
:deep(.p-dialog-content) {
  padding: 1rem 1.25rem 1.25rem;
}

/* Status badge overrides */
:deep(.status-badge.in-transit) { background: var(--blue-dim); color: var(--blue); }
:deep(.status-badge.assigned) { background: var(--accent-dim); color: var(--accent); }
:deep(.status-badge.dispatched) { background: var(--blue-dim); color: var(--blue); }
:deep(.status-badge.delivered) { background: rgba(16,185,129,0.2); color: #059669; }
:deep(.status-badge.unassigned) { background: var(--danger-dim); color: var(--danger); }
:deep(.status-badge.picked-up) { background: var(--amber-dim); color: var(--amber); }

.skeleton-line { height: 0.85rem; margin-bottom: 0.4rem; }
.skeleton-line.lg { height: 1.75rem; width: 60%; }
.skeleton-line.sm { height: 0.7rem; width: 40%; }

</style>
