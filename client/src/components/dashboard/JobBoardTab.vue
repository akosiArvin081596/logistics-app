<template>
  <div>
    <div class="px-4 py-3 border-b border-gray-100 bg-gray-50/30">
      <input v-model="searchQuery" type="text" placeholder="Search load number..."
        class="w-full max-w-[300px] px-3.5 py-2 text-sm bg-gray-50/80 border border-gray-200 rounded-lg text-gray-800 placeholder-gray-400 outline-none focus:border-sky-300 focus:bg-white focus:shadow-[0_0_0_3px_rgba(56,189,248,0.1)] transition-all duration-200" />
    </div>

    <div class="overflow-x-auto">
      <SkeletonLoader v-if="loading" />
      <table v-else-if="filteredJobs.length > 0" class="w-full text-[13px]">
        <thead>
          <tr class="bg-gray-50/70 border-b border-gray-200">
            <th v-for="col in displayCols" :key="col" class="px-4 py-3.5 text-left text-[10px] font-bold uppercase tracking-[0.08em] text-gray-400 whitespace-nowrap">{{ col }}</th>
            <th class="px-4 py-3.5 text-left text-[10px] font-bold uppercase tracking-[0.08em] text-gray-400 whitespace-nowrap">Assign Driver</th>
          </tr>
        </thead>
        <tbody>
          <tr v-for="job in paginatedItems" :key="job._rowIndex" class="border-b border-gray-100/80 hover:bg-sky-50/30 cursor-pointer transition-all duration-150 group" @click="openDetail(job)">
            <td v-for="col in displayCols" :key="col" class="px-4 py-3.5">
              <StatusBadge v-if="/status/i.test(col)" :status="job[col] || 'Unassigned'" />
              <template v-else>{{ cellValue(job, col) }}</template>
            </td>
            <td class="px-4 py-3.5" @click.stop>
              <div v-if="!hideAssign(job)" class="flex items-center gap-2">
                <select v-model="assignSelections[job._rowIndex]" class="px-2.5 py-1.5 text-[13px] bg-white border border-gray-200 rounded-lg text-gray-700 outline-none focus:border-sky-300 focus:shadow-[0_0_0_3px_rgba(56,189,248,0.08)] min-w-[140px] transition-all duration-150">
                  <option value="">Select driver</option>
                  <option v-for="d in drivers" :key="d" :value="d">{{ d }}</option>
                </select>
                <button class="px-3.5 py-1.5 text-xs font-semibold bg-sky-500 text-white rounded-lg hover:bg-sky-600 active:scale-[0.96] transition-all duration-150 shadow-[0_1px_3px_rgba(56,189,248,0.3)]" @click="assign(job)">Assign</button>
              </div>
              <span v-else class="text-gray-300">&mdash;</span>
            </td>
          </tr>
        </tbody>
      </table>
      <EmptyState v-else>{{ searchQuery ? 'No loads match your search.' : 'All loads are assigned.' }}</EmptyState>
    </div>
    <PaginationBar :page="page" :page-size="pageSize" :total="filteredJobs.length" :total-pages="totalPages" @go="goTo" @size="setSize" />

    <Teleport to="body">
      <div v-if="selectedJob" class="fixed inset-0 bg-black/30 backdrop-blur-sm z-[200] flex items-center justify-center" @click.self="selectedJob = null">
        <div class="bg-white rounded-2xl w-[92%] max-w-[680px] max-h-[85vh] flex flex-col shadow-[0_8px_30px_rgba(0,0,0,0.12),0_24px_60px_rgba(0,0,0,0.1)]">
          <div class="flex items-center justify-between px-6 py-4 border-b border-gray-100 bg-gray-50/50">
            <div class="flex items-center gap-3">
              <h3 class="text-lg font-bold">{{ loadIdValue || 'Load Details' }}</h3>
              <StatusBadge v-if="statusValue" :status="statusValue" />
            </div>
            <button class="w-8 h-8 flex items-center justify-center rounded-lg hover:bg-gray-100 text-gray-300 hover:text-gray-600 text-lg transition-colors duration-150" @click="selectedJob = null">&times;</button>
          </div>
          <div class="p-5 overflow-y-auto flex-1">
            <template v-for="section in detailSections" :key="section.title">
              <div v-if="section.fields.length" class="mb-4">
                <div class="text-[0.68rem] font-bold uppercase tracking-[0.1em] text-gray-400 mb-2.5 flex items-center gap-2"><span class="w-1 h-3 bg-sky-400 rounded-full"></span>{{ section.title }}</div>
                <div class="bg-gray-50/50 border border-gray-200/80 rounded-xl grid grid-cols-2 overflow-hidden">
                  <div v-for="field in section.fields" :key="field.col" :class="['flex flex-col gap-0.5 p-3 border-b border-gray-100', field.wide ? 'col-span-2' : '']">
                    <span class="text-[0.68rem] font-semibold uppercase text-gray-400">{{ field.col }}</span>
                    <span class="text-sm">
                      <StatusBadge v-if="/status/i.test(field.col) && field.value" :status="field.value" />
                      <template v-else>{{ field.value || '\u2014' }}</template>
                    </span>
                  </div>
                </div>
              </div>
            </template>
            <div class="mb-4">
              <div class="text-[0.68rem] font-bold uppercase tracking-[0.1em] text-gray-400 mb-2.5 flex items-center gap-2"><span class="w-1 h-3 bg-sky-400 rounded-full"></span>Route Map</div>
              <DriverRouteMap :load="selectedJob" :headers="headers" :driver-position="null" dispatch-mode />
            </div>
          </div>
        </div>
      </div>
    </Teleport>
  </div>
</template>

<script setup>
import { computed, reactive, ref } from 'vue'
import { usePagination } from '../../composables/usePagination'
import { useToast } from '../../composables/useToast'
import StatusBadge from '../shared/StatusBadge.vue'
import EmptyState from '../shared/EmptyState.vue'
import PaginationBar from '../shared/PaginationBar.vue'
import SkeletonLoader from '../shared/SkeletonLoader.vue'
import DriverRouteMap from '../driver/DriverRouteMap.vue'

const props = defineProps({ jobs: { type: Array, required: true }, drivers: { type: Array, required: true }, headers: { type: Array, required: true }, loading: { type: Boolean, default: false } })
const emit = defineEmits(['assign'])
const { show: toast } = useToast()
const assignSelections = reactive({})
const selectedJob = ref(null)
const searchQuery = ref('')
const loadIdCol = computed(() => props.headers.find(h => /load.?id|job.?id/i.test(h)) || '')
const filteredJobs = computed(() => { const q = searchQuery.value.trim().toLowerCase(); if (!q || !loadIdCol.value) return props.jobs; return props.jobs.filter(j => (j[loadIdCol.value] || '').toString().toLowerCase().includes(q)) })
const statusCol = computed(() => props.headers.find(h => /status/i.test(h)) || null)
function hideAssign(j) { if (statusCol.value && /^(completed|canceled)$/i.test((j[statusCol.value] || '').trim())) return true; return false }
function openDetail(j) { selectedJob.value = j }
const { page, pageSize, totalPages, paginatedItems, goTo, setSize } = usePagination(filteredJobs)
const brokerSourceCol = computed(() => props.headers.find(h => /broker/i.test(h)) || null)
const phoneSourceCol = computed(() => props.headers.find(h => /phone/i.test(h)) || null)
const displayCols = computed(() => { const kw = ['load', 'status', 'origin', 'pickup', 'destination', 'drop', 'rate', 'amount']; const m = []; for (const k of kw) { const c = props.headers.find(h => new RegExp(k, 'i').test(h) && !m.includes(h)); if (c) m.push(c) }; return (m.length < 3 ? props.headers.slice(0, 8) : m).filter(c => c !== brokerSourceCol.value && c !== phoneSourceCol.value) })
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
const statusValue = computed(() => { if (!selectedJob.value) return ''; const c = props.headers.find(h => /^status$/i.test(h) || /load.*status/i.test(h)); return c ? selectedJob.value[c] || '' : '' })
const detailSections = computed(() => {
  if (!selectedJob.value) return []; const used = new Set(); const secs = []
  for (const c of props.headers) { if (hiddenCols.test(c)) used.add(c) }
  for (const sp of sectionPatterns) { const f = []; for (const c of props.headers) { if (used.has(c)) continue; if (sp.test.test(c)) { used.add(c); f.push({ col: c, value: detailValue(selectedJob.value, c), wide: sp.wide ? sp.wide.test(c) : false }) } }; secs.push({ title: sp.title, fields: f }) }
  const rem = []; for (const c of props.headers) { if (used.has(c)) continue; rem.push({ col: c, value: detailValue(selectedJob.value, c), wide: false }) }
  if (rem.length) secs.push({ title: 'Other Details', fields: rem }); return secs.filter(s => s.fields.length > 0)
})
function assign(j) { const d = assignSelections[j._rowIndex]; if (!d) { toast('Select a driver first', 'error'); return }; emit('assign', { rowIndex: j._rowIndex, driver: d, job: j }) }
</script>
