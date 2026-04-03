<template>
  <div class="flex flex-col overflow-hidden h-full">
    <div class="dash-header">
      <div>
        <h2 class="text-[1.4rem] font-bold text-gray-900 tracking-tight">Operations Dashboard</h2>
        <p class="text-[13px] text-gray-400 mt-0.5">Real-time logistics overview</p>
      </div>
      <div class="flex items-center gap-3">
        <span class="text-[11px] text-gray-400 font-mono bg-gray-50 px-3 py-1.5 rounded-full border border-gray-100">{{ lastUpdated }}</span>
        <button class="px-4 py-2 text-sm font-semibold bg-white text-gray-700 border border-gray-200 rounded-lg hover:border-gray-300 hover:shadow-sm active:scale-[0.97] transition-all duration-150" @click="refresh">
          &#8635; Refresh
        </button>
      </div>
    </div>

    <template v-if="store.kpis">
      <KpiGrid :kpis="store.kpis" :completed-total="store.completedJobs.length" @card-click="handleKpiClick" />
    </template>
    <template v-else>
      <div class="kpi-grid">
        <div v-for="n in 4" :key="n" class="bg-white border border-gray-100 rounded-xl p-5 animate-pulse" :style="{ animationDelay: (n * 0.1) + 's' }">
          <div class="h-3 bg-gray-100 rounded-full w-1/2 mb-3"></div>
          <div class="h-8 bg-gray-100 rounded-lg w-2/3 mb-2"></div>
          <div class="h-2.5 bg-gray-50 rounded-full w-1/3"></div>
        </div>
      </div>
    </template>

    <Card class="flex-1 flex flex-col min-h-0 overflow-hidden" style="margin-top:1.25rem;border-radius:14px;border:1px solid #e8edf2;box-shadow:0 1px 4px rgba(0,0,0,0.06), 0 4px 12px rgba(0,0,0,0.04);">
      <Tabs :model-value="activeTab" @update:model-value="v => activeTab = v">
        <TabsList class="w-full justify-start rounded-none border-b bg-muted/50 h-auto" style="padding:0 0.75rem;">
          <TabsTrigger v-for="tab in tabs" :key="tab.key" :value="tab.key"
            class="rounded-none data-[state=active]:shadow-none data-[state=active]:bg-transparent"
            style="padding:1rem 1.25rem;">
            <span class="border-b-2 border-transparent" :class="activeTab === tab.key ? 'border-primary' : ''" style="padding-bottom:2px;">{{ tab.label }}</span>
            <Badge variant="secondary" class="font-mono" style="margin-left:0.5rem;">{{ tab.count }}</Badge>
          </TabsTrigger>
        </TabsList>
        <CardContent class="flex-1 overflow-y-auto" style="padding:0;">
          <TabsContent value="jobBoard" style="margin-top:0;">
            <JobBoardTab :jobs="store.unassignedJobs" :drivers="store.drivers" :headers="store.headers" :loading="store.isLoading" @assign="handleAssign" />
          </TabsContent>
          <TabsContent value="activeLoads" style="margin-top:0;">
            <ActiveLoadsTab :jobs="store.activeJobs" :headers="store.headers" :drivers="store.drivers" @reassign="handleReassign" @cancel="handleCancel" @status-update="handleStatusUpdate" />
          </TabsContent>
          <TabsContent value="completed" style="margin-top:0;">
            <CompletedLoadsTab :jobs="store.completedJobs" :headers="store.completedHeaders" />
          </TabsContent>
          <TabsContent value="fleet" style="margin-top:0;">
            <FleetTab :fleet="store.fleet" :active-jobs="store.activeJobs" :headers="store.headers" />
          </TabsContent>
        </CardContent>
      </Tabs>
    </Card>
  </div>
</template>

<script setup>
import { ref, computed, onMounted, onUnmounted } from 'vue'
import { useDashboardStore } from '../stores/dashboard'
import { useSocket } from '../composables/useSocket'
import { useToast } from '../composables/useToast'
import { Card, CardContent } from '@/components/ui/card'
import { Tabs, TabsList, TabsTrigger, TabsContent } from '@/components/ui/tabs'
import { Badge } from '@/components/ui/badge'
import KpiGrid from '../components/dashboard/KpiGrid.vue'
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
