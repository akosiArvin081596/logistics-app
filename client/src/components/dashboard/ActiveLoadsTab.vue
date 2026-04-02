<template>
  <div>
    <div class="px-3 py-2 border-b border-gray-200">
      <input v-model="searchQuery" type="text" placeholder="Search load number..."
        class="w-full max-w-[280px] px-3 py-1.5 text-sm bg-white border border-gray-200 rounded-lg text-gray-800 placeholder-gray-400 outline-none focus:border-sky-400/50" />
    </div>

    <div class="overflow-x-auto">
      <table v-if="filteredJobs.length > 0" class="w-full text-sm">
        <thead>
          <tr class="border-b border-gray-200">
            <th v-for="col in displayCols" :key="col" class="px-3 py-2.5 text-left text-[0.68rem] font-semibold uppercase tracking-wider text-gray-400">{{ col }}</th>
            <th class="px-3 py-2.5 text-left text-[0.68rem] font-semibold uppercase tracking-wider text-gray-400">Actions</th>
          </tr>
        </thead>
        <tbody>
          <tr v-for="job in paginatedItems" :key="job._rowIndex" class="border-b border-gray-100 hover:bg-gray-50 cursor-pointer" @click="openDetail(job)">
            <td v-for="col in displayCols" :key="col" class="px-3 py-2.5">
              <StatusBadge v-if="/status/i.test(col) && job[col]" :status="job[col]" />
              <template v-else>{{ cellValue(job, col) }}</template>
            </td>
            <td class="px-3 py-2.5" @click.stop>
              <div class="flex items-center gap-1.5 flex-wrap">
                <select v-model="statusSelections[job._rowIndex]" class="px-2 py-1 text-xs bg-white border border-gray-200 rounded text-gray-800 outline-none w-[110px]">
                  <option value="">{{ getCurrentStatus(job) || 'Status' }}</option>
                  <option v-for="s in statusOptions" :key="s" :value="s">{{ s }}</option>
                </select>
                <button v-if="statusSelections[job._rowIndex]" class="px-2 py-1 text-xs font-semibold bg-sky-500 text-white rounded hover:bg-sky-600" @click="confirmStatusUpdate(job)">Go</button>
                <select v-model="reassignSelections[job._rowIndex]" class="px-2 py-1 text-xs bg-white border border-gray-200 rounded text-gray-800 outline-none w-[120px]">
                  <option value="">{{ getCurrentDriver(job) || 'Driver' }}</option>
                  <option v-for="d in drivers" :key="d" :value="d">{{ d }}</option>
                </select>
                <button v-if="reassignSelections[job._rowIndex]" class="px-2 py-1 text-xs font-semibold bg-sky-500 text-white rounded hover:bg-sky-600" @click="confirmReassign(job)">Go</button>
                <button class="px-2 py-1 text-xs text-red-400 hover:text-red-300" @click="confirmCancel(job)">Cancel</button>
              </div>
            </td>
          </tr>
        </tbody>
      </table>
      <EmptyState v-else>{{ searchQuery ? 'No loads match your search.' : 'No active loads right now.' }}</EmptyState>
    </div>
    <PaginationBar :page="page" :page-size="pageSize" :total="filteredJobs.length" :total-pages="totalPages" @go="goTo" @size="setSize" />

    <Teleport to="body">
      <div v-if="selectedJob" class="fixed inset-0 bg-black/30 backdrop-blur-sm z-[200] flex items-center justify-center" @click.self="closeDetail">
        <div class="bg-white rounded-2xl w-[92%] max-w-[680px] max-h-[85vh] flex flex-col shadow-2xl">
          <div class="flex items-center justify-between px-5 py-4 border-b border-gray-200">
            <div class="flex items-center gap-3">
              <h3 class="text-lg font-bold">{{ loadIdValue || 'Load Details' }}</h3>
            </div>
            <button class="w-8 h-8 flex items-center justify-center rounded-lg hover:bg-gray-100 text-gray-400 hover:text-gray-800 text-xl" @click="closeDetail">&times;</button>
          </div>
          <div class="p-5 overflow-y-auto flex-1">
            <template v-for="section in detailSections" :key="section.title">
              <div v-if="section.fields.length" class="mb-4">
                <div class="text-[0.68rem] font-bold uppercase tracking-wider text-gray-400 mb-2">{{ section.title }}</div>
                <div class="bg-white border border-gray-200 rounded-lg grid grid-cols-2 overflow-hidden">
                  <div v-for="field in section.fields" :key="field.col" :class="['flex flex-col gap-0.5 p-3 border-b border-gray-100', field.wide ? 'col-span-2' : '']">
                    <span class="text-[0.68rem] font-semibold uppercase text-gray-400">{{ field.col }}</span>
                    <span class="text-sm">{{ field.value || '\u2014' }}</span>
                  </div>
                </div>
              </div>
            </template>
            <div class="mb-4">
              <div class="text-[0.68rem] font-bold uppercase tracking-wider text-gray-400 mb-2">Documents</div>
              <div class="bg-white border border-gray-200 rounded-lg p-3">
                <div v-if="loadingDocs" class="text-center text-gray-500 text-sm py-3">Loading...</div>
                <div v-else-if="loadDocs.length === 0" class="text-center text-gray-500 text-sm py-3">No documents</div>
                <div v-else class="space-y-2">
                  <div v-for="doc in loadDocs" :key="doc.id" class="flex items-center justify-between py-1">
                    <div class="flex items-center gap-2">
                      <span class="text-xs font-semibold px-2 py-0.5 rounded bg-sky-50 text-sky-600">{{ doc.type }}</span>
                      <span class="text-sm">{{ doc.file_name }}</span>
                    </div>
                    <a v-if="doc.drive_url" :href="doc.drive_url" target="_blank" class="text-xs text-sky-400 hover:underline">View</a>
                  </div>
                </div>
              </div>
            </div>
            <div>
              <div class="text-[0.68rem] font-bold uppercase tracking-wider text-gray-400 mb-2">Route Map</div>
              <DriverRouteMap :load="selectedJob" :headers="headers" :driver-position="selectedDriverPosition" dispatch-mode />
            </div>
          </div>
        </div>
      </div>
    </Teleport>
  </div>
</template>

<script setup>
import { computed, ref, reactive } from 'vue'
import { usePagination } from '../../composables/usePagination'
import { useApi } from '../../composables/useApi'
import StatusBadge from '../shared/StatusBadge.vue'
import EmptyState from '../shared/EmptyState.vue'
import PaginationBar from '../shared/PaginationBar.vue'
import DriverRouteMap from '../driver/DriverRouteMap.vue'

const api = useApi()
const props = defineProps({ jobs: { type: Array, required: true }, headers: { type: Array, required: true }, drivers: { type: Array, default: () => [] } })
const emit = defineEmits(['reassign', 'cancel', 'status-update'])
const searchQuery = ref('')
const loadIdCol = computed(() => props.headers.find(h => /load.?id|job.?id/i.test(h)) || '')
const filteredJobs = computed(() => { const q = searchQuery.value.trim().toLowerCase(); if (!q || !loadIdCol.value) return props.jobs; return props.jobs.filter(j => (j[loadIdCol.value] || '').toString().toLowerCase().includes(q)) })
const { page, pageSize, totalPages, paginatedItems, goTo, setSize } = usePagination(filteredJobs)
const statusOptions = ['At Shipper', 'Loading', 'In Transit', 'At Receiver', 'Unloading', 'Delivered']
const selectedJob = ref(null); const selectedDriverPosition = ref(null); const reassignSelections = reactive({}); const statusSelections = reactive({}); const loadDocs = ref([]); const loadingDocs = ref(false)
const statusCol = computed(() => props.headers.find(h => /status/i.test(h)) || ''); const driverCol = computed(() => props.headers.find(h => /driver/i.test(h)) || '')
function getCurrentStatus(j) { return statusCol.value ? (j[statusCol.value] || '') : '' }
function getCurrentDriver(j) { return driverCol.value ? (j[driverCol.value] || '') : '' }
function confirmReassign(j) { const d = reassignSelections[j._rowIndex]; if (!d) return; if (confirm(`Reassign to ${d}?`)) { emit('reassign', { rowIndex: j._rowIndex, newDriver: d, job: j }); reassignSelections[j._rowIndex] = '' } }
function confirmCancel(j) { if (confirm('Cancel this assignment?')) emit('cancel', { rowIndex: j._rowIndex, job: j }) }
function confirmStatusUpdate(j) { const s = statusSelections[j._rowIndex]; if (!s) return; if (confirm(`Update to "${s}"?`)) { emit('status-update', { rowIndex: j._rowIndex, newStatus: s, job: j }); statusSelections[j._rowIndex] = '' } }
function closeDetail() { selectedJob.value = null; selectedDriverPosition.value = null }
async function openDetail(job) {
  selectedJob.value = job; selectedDriverPosition.value = null; loadDocs.value = []; loadingDocs.value = true
  const dc = props.headers.find(h => /driver/i.test(h)); const dn = dc ? (job[dc] || '').trim() : ''
  const lc = props.headers.find(h => /load.?id|job.?id/i.test(h)); const lid = lc ? (job[lc] || '').trim() : ''
  const p = []
  if (dn) p.push(api.get('/api/locations/latest').then(d => { const l = (d.locations||[]).find(x => x.driver.toLowerCase() === dn.toLowerCase() && x.latitude); if (l) selectedDriverPosition.value = { latitude: l.latitude, longitude: l.longitude } }).catch(() => {}))
  if (lid) p.push(api.get(`/api/documents/${encodeURIComponent(lid)}`).then(r => { loadDocs.value = r.documents || [] }).catch(() => {}))
  await Promise.all(p); loadingDocs.value = false
}
const brokerSourceCol = computed(() => props.headers.find(h => /broker/i.test(h)) || null); const phoneSourceCol = computed(() => props.headers.find(h => /phone/i.test(h)) || null)
const displayCols = computed(() => { const kw = ['load', 'status', 'driver', 'origin', 'pickup', 'destination', 'drop', 'rate', 'delivery']; const m = []; for (const k of kw) { const c = props.headers.find(h => new RegExp(k, 'i').test(h) && !m.includes(h)); if (c) m.push(c) }; return (m.length < 3 ? props.headers.slice(0, 8) : m).filter(c => c !== brokerSourceCol.value && c !== phoneSourceCol.value) })
function parseJsonCell(r) { if (!r || typeof r !== 'string' || r[0] !== '{') return null; try { return JSON.parse(r) } catch { return null } }
function cellValue(j, c) { const v = j[c] || ''; const p = parseJsonCell(v); return p ? (p.Name || p.name || Object.values(p).filter(Boolean).join(' \u2022 ')) : v }
function detailValue(j, c) { const v = j[c] || ''; const p = parseJsonCell(v); return p ? Object.entries(p).filter(([,x]) => x).map(([k,x]) => `${k}: ${x}`).join(', ') : v }
const sectionPatterns = [
  { title: 'Load Information', test: /load|job|id|status|driver|truck|trailer|equipment|type|commodity|weight|miles|details/i, wide: /details|commodity/i },
  { title: 'Route', test: /origin|pickup|shipper|dest|drop|receiver|delivery|consignee|city|state|zip|address|location/i, wide: /address/i },
  { title: 'Schedule', test: /date|time|pickup.*date|delivery.*date|appointment|eta|scheduled/i },
  { title: 'Financials', test: /rate|amount|revenue|pay|charge|price|cost|invoice|total/i },
]
const hiddenCols = /broker|phone|email|contact|contract/i
const loadIdValue = computed(() => { if (!selectedJob.value) return ''; const c = props.headers.find(h => /load.?id|job.?id/i.test(h)); return c ? selectedJob.value[c] || '' : '' })
const detailSections = computed(() => {
  if (!selectedJob.value) return []; const used = new Set(); const secs = []
  for (const c of props.headers) { if (hiddenCols.test(c)) used.add(c) }
  for (const sp of sectionPatterns) { const f = []; for (const c of props.headers) { if (used.has(c)) continue; if (sp.test.test(c)) { used.add(c); f.push({ col: c, value: detailValue(selectedJob.value, c), wide: sp.wide ? sp.wide.test(c) : false }) } }; secs.push({ title: sp.title, fields: f }) }
  const rem = []; for (const c of props.headers) { if (used.has(c)) continue; rem.push({ col: c, value: detailValue(selectedJob.value, c), wide: false }) }
  if (rem.length) secs.push({ title: 'Other Details', fields: rem }); return secs.filter(s => s.fields.length > 0)
})
</script>
