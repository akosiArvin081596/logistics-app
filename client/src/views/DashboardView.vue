<template>
  <div class="flex flex-col overflow-hidden h-full">
    <div class="flex items-center justify-between mb-4 shrink-0">
      <h2 class="text-xl font-bold text-gray-800">Operations Dashboard</h2>
      <div class="flex items-center gap-3">
        <span class="text-xs text-gray-500 font-mono bg-gray-100 px-3 py-1.5 rounded-full">{{ lastUpdated }}</span>
        <button class="px-3 py-1.5 text-sm font-medium bg-sky-50 text-sky-600 border border-sky-200 rounded-lg hover:bg-sky-100 transition" @click="refresh">
          Refresh
        </button>
      </div>
    </div>

    <template v-if="store.kpis">
      <KpiGrid :kpis="store.kpis" @card-click="handleKpiClick" />
      <RevenueGrid :revenue="store.revenue" />
    </template>
    <template v-else>
      <div class="grid grid-cols-4 gap-3 mb-3">
        <div v-for="n in 4" :key="n" class="bg-white border border-gray-200 rounded-xl p-4 animate-pulse">
          <div class="h-3 bg-gray-100 rounded w-1/2 mb-2"></div>
          <div class="h-7 bg-gray-100 rounded w-2/3 mb-2"></div>
          <div class="h-2.5 bg-gray-100 rounded w-1/3"></div>
        </div>
      </div>
    </template>

    <div class="flex-1 flex flex-col min-h-0 bg-white border border-gray-200 rounded-xl overflow-hidden shadow-sm">
      <div class="flex border-b border-gray-200 shrink-0">
        <button v-for="tab in tabs" :key="tab.key"
          :class="['px-4 py-3 text-sm font-semibold flex items-center gap-2 border-b-2 transition',
            activeTab === tab.key ? 'text-sky-600 border-sky-500' : 'text-gray-400 border-transparent hover:text-gray-600']"
          @click="activeTab = tab.key">
          {{ tab.label }}
          <span class="text-xs font-mono bg-gray-100 text-gray-500 px-2 py-0.5 rounded-full">{{ tab.count }}</span>
        </button>
      </div>

      <div class="flex-1 overflow-y-auto">
        <JobBoardTab v-show="activeTab === 'jobBoard'" :jobs="store.unassignedJobs" :drivers="store.drivers" :headers="store.headers" :loading="store.isLoading" @assign="handleAssign" />
        <ActiveLoadsTab v-show="activeTab === 'activeLoads'" :jobs="store.activeJobs" :headers="store.headers" :drivers="store.drivers" @reassign="handleReassign" @cancel="handleCancel" @status-update="handleStatusUpdate" />
        <CompletedLoadsTab v-show="activeTab === 'completed'" :jobs="store.completedJobs" :headers="store.completedHeaders" />
        <FleetTab v-show="activeTab === 'fleet'" :fleet="store.fleet" :active-jobs="store.activeJobs" :headers="store.headers" />
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
let refreshInterval = null

const tabs = computed(() => [
  { key: 'jobBoard', label: 'Job Board', count: store.unassignedJobs.length },
  { key: 'activeLoads', label: 'Active Loads', count: store.activeJobs.length },
  { key: 'completed', label: 'Completed', count: store.completedJobs.length },
  { key: 'fleet', label: 'Fleet & Drivers', count: store.fleet.length },
])

const lastUpdated = computed(() => {
  if (!store.timestamp) return 'Loading...'
  return 'Updated ' + new Date(store.timestamp).toLocaleTimeString()
})

function handleKpiClick(key) { const m = { active: 'activeLoads', unassigned: 'jobBoard', completed: 'completed', fleet: 'fleet' }; activeTab.value = m[key] || activeTab.value }
async function refresh() { try { await store.refresh() } catch { toast('Failed to load dashboard', 'error') } }
async function handleAssign({ rowIndex, driver, job }) { try { await store.assignDriver(rowIndex, driver, job, store.headers); const lc = store.headers.find(h => /load.?id|job.?id/i.test(h)); toast(`${driver} assigned to ${lc ? job[lc] : 'load'}`, 'success'); refresh() } catch { toast('Failed to assign', 'error') } }
async function handleReassign({ rowIndex, newDriver, job }) { try { await store.reassignDriver(rowIndex, newDriver, job, store.headers); toast(`Reassigned to ${newDriver}`, 'success'); refresh() } catch { toast('Failed to reassign', 'error') } }
async function handleCancel({ rowIndex, job }) { try { await store.cancelLoad(rowIndex, job, store.headers); toast('Assignment cancelled', 'success'); refresh() } catch { toast('Failed to cancel', 'error') } }
async function handleStatusUpdate({ rowIndex, newStatus, job }) { try { const lc = store.headers.find(h => /load.?id|job.?id/i.test(h)); const dc = store.headers.find(h => /driver/i.test(h)); await store.updateStatus(rowIndex, dc ? job[dc] || '' : '', lc ? job[lc] || '' : '', newStatus); toast(`Status: ${newStatus}`, 'success'); refresh() } catch { toast('Failed to update', 'error') } }
function onStatusUpdated(p) { toast(`${p.driverName}: ${p.newStatus}`, 'info'); refresh() }
function onPodUploaded(p) { toast(`POD uploaded: ${p.loadId}`, 'success'); refresh() }

onMounted(() => { refresh(); socket.connect(); socket.register('dispatch'); socket.on('status-updated', onStatusUpdated); socket.on('pod-uploaded', onPodUploaded); refreshInterval = setInterval(refresh, 60000) })
onUnmounted(() => { clearInterval(refreshInterval); socket.off('status-updated', onStatusUpdated); socket.off('pod-uploaded', onPodUploaded) })
</script>
