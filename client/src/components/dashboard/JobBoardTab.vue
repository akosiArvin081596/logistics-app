<template>
  <div>
    <div class="flex align-items-center gap-3 p-2 border-bottom-1 surface-border">
      <IconField>
        <InputIcon class="pi pi-search" />
        <InputText v-model="searchQuery" placeholder="Search load number..." size="small" />
      </IconField>
    </div>

    <div>
      <SkeletonLoader v-if="loading" />
      <DataTable
        v-else-if="filteredJobs.length > 0"
        :value="paginatedItems"
        :rows="pageSize"
        size="small"
        row-hover
        @row-click="openDetail($event.data)"
      >
        <Column v-for="col in displayCols" :key="col" :field="col" :header="col" sortable>
          <template #body="{ data }">
            <StatusBadge v-if="/status/i.test(col)" :status="data[col] || 'Unassigned'" />
            <span v-else-if="missingData(data) && displayCols.indexOf(col) === 0">
              <i class="pi pi-exclamation-triangle text-orange-500 mr-1" :title="missingData(data)"></i>
              {{ cellValue(data, col) }}
            </span>
            <template v-else>{{ cellValue(data, col) }}</template>
          </template>
        </Column>
        <Column header="Assign Driver" :style="{ minWidth: '200px' }">
          <template #body="{ data }">
            <div v-if="!hideAssign(data)" class="flex align-items-center gap-2" @click.stop>
              <Select v-model="assignSelections[data._rowIndex]" :options="drivers" placeholder="Select driver" size="small" style="min-width:140px;" />
              <Button label="Assign" size="small" @click.stop="assign(data)" />
            </div>
            <span v-else class="text-color-secondary">&mdash;</span>
          </template>
        </Column>
      </DataTable>
      <EmptyState v-else>{{ searchQuery ? 'No loads match your search.' : 'All loads are assigned.' }}</EmptyState>
    </div>
    <PaginationBar :page="page" :page-size="pageSize" :total="filteredJobs.length" :total-pages="totalPages" @go="goTo" @size="setSize" />

    <Dialog v-model:visible="showDetail" :header="loadIdValue || 'Load Details'" modal :style="{ width: '680px', maxWidth: '95vw' }" :dismissable-mask="true">
      <template v-if="selectedJob">
        <template v-for="section in detailSections" :key="section.title">
          <div v-if="section.fields.length" class="mb-3">
            <div class="text-xs font-bold text-color-secondary uppercase mb-2" style="letter-spacing:0.06em;">{{ section.title }}</div>
            <div class="surface-card border-1 surface-border border-round-lg overflow-hidden grid grid-cols-2">
              <div v-for="field in section.fields" :key="field.col" :class="['flex flex-column gap-1 p-3 border-bottom-1 surface-border', { 'col-span-2': field.wide }]">
                <span class="text-xs font-semibold text-color-secondary uppercase">{{ field.col }}</span>
                <span class="text-sm font-medium">
                  <StatusBadge v-if="/status/i.test(field.col) && field.value" :status="field.value" />
                  <template v-else>{{ field.value || '\u2014' }}</template>
                </span>
              </div>
            </div>
          </div>
        </template>
        <div class="mb-3">
          <div class="text-xs font-bold text-color-secondary uppercase mb-2" style="letter-spacing:0.06em;">Route Map</div>
          <DriverRouteMap :load="selectedJob" :headers="headers" :driver-position="null" dispatch-mode />
        </div>
      </template>
    </Dialog>
  </div>
</template>

<script setup>
import { computed, reactive, ref, watch } from 'vue'
import DataTable from 'primevue/datatable'
import Column from 'primevue/column'
import Dialog from 'primevue/dialog'
import Button from 'primevue/button'
import Select from 'primevue/select'
import InputText from 'primevue/inputtext'
import IconField from 'primevue/iconfield'
import InputIcon from 'primevue/inputicon'
import { usePagination } from '../../composables/usePagination'
import { useToast } from '../../composables/useToast'
import StatusBadge from '../shared/StatusBadge.vue'
import EmptyState from '../shared/EmptyState.vue'
import PaginationBar from '../shared/PaginationBar.vue'
import SkeletonLoader from '../shared/SkeletonLoader.vue'
import DriverRouteMap from '../driver/DriverRouteMap.vue'

const props = defineProps({
  jobs: { type: Array, required: true },
  drivers: { type: Array, required: true },
  headers: { type: Array, required: true },
  loading: { type: Boolean, default: false },
  showMap: { type: Number, default: 0 },
})

const emit = defineEmits(['assign'])
const { show: toast } = useToast()
const assignSelections = reactive({})
const selectedJob = ref(null)
const showDetail = ref(false)
const searchQuery = ref('')
const loadIdCol = computed(() => props.headers.find(h => /load.?id|job.?id/i.test(h)) || '')
const filteredJobs = computed(() => {
  const q = searchQuery.value.trim().toLowerCase()
  if (!q || !loadIdCol.value) return props.jobs
  return props.jobs.filter(job => (job[loadIdCol.value] || '').toString().toLowerCase().includes(q))
})
const statusCol = computed(() => props.headers.find(h => /status/i.test(h)) || null)

function hideAssign(job) {
  if (statusCol.value && /^(completed|canceled)$/i.test((job[statusCol.value] || '').trim())) return true
  const warn = missingData(job)
  if (warn.includes('Missing pickup location') || warn.includes('Missing delivery location')) return true
  return false
}
function openDetail(job) { selectedJob.value = job; showDetail.value = true }
function detailValue(job, col) { const val = job[col] || ''; const p = parseJsonCell(val); return p ? Object.entries(p).filter(([,v]) => v).map(([k,v]) => `${k}: ${v}`).join(', ') : val }

const sectionPatterns = [
  { title: 'Load Information', test: /load|job|id|status|driver|truck|trailer|equipment|type|commodity|weight|miles|details/i, wide: /details|commodity/i },
  { title: 'Route', test: /origin|pickup|shipper|dest|drop|receiver|delivery|consignee|city|state|zip|address|location/i, wide: /address/i },
  { title: 'Schedule', test: /date|time|pickup.*date|delivery.*date|appointment|eta|scheduled/i },
  { title: 'Financials', test: /rate|amount|revenue|pay|charge|price|cost|invoice|total/i },
]
const hiddenCols = /broker|phone|email|contact|contract/i
const loadIdValue = computed(() => { if (!selectedJob.value) return ''; const c = props.headers.find(h => /load.?id|job.?id/i.test(h)); return c ? selectedJob.value[c] || '' : '' })
const detailSections = computed(() => {
  if (!selectedJob.value) return []
  const used = new Set(); const sections = []
  for (const c of props.headers) { if (hiddenCols.test(c)) used.add(c) }
  for (const sp of sectionPatterns) { const f = []; for (const c of props.headers) { if (used.has(c)) continue; if (sp.test.test(c)) { used.add(c); f.push({ col: c, value: detailValue(selectedJob.value, c), wide: sp.wide ? sp.wide.test(c) : false }) } }; sections.push({ title: sp.title, fields: f }) }
  const rem = []; for (const c of props.headers) { if (used.has(c)) continue; rem.push({ col: c, value: detailValue(selectedJob.value, c), wide: false }) }
  if (rem.length) sections.push({ title: 'Other Details', fields: rem })
  return sections.filter(s => s.fields.length > 0)
})

const pickupAddrCol = computed(() => props.headers.find(h => /pickup.*addr/i.test(h)) || null)
const dropoffAddrCol = computed(() => props.headers.find(h => /drop.*addr/i.test(h)) || null)
const originLatCol = computed(() => props.headers.find(h => /origin.*lat|pickup.*lat|shipper.*lat/i.test(h)) || null)
const destLatCol = computed(() => props.headers.find(h => /dest.*lat|drop.*lat|receiver.*lat|delivery.*lat/i.test(h)) || null)
function missingData(job) {
  const w = []
  if (!pickupAddrCol.value || !(job[pickupAddrCol.value] || '').trim()) { if (!originLatCol.value || !(job[originLatCol.value] || '').trim()) w.push('Missing pickup location') } else if (!originLatCol.value || !(job[originLatCol.value] || '').trim()) w.push('Missing pickup coordinates')
  if (!dropoffAddrCol.value || !(job[dropoffAddrCol.value] || '').trim()) { if (!destLatCol.value || !(job[destLatCol.value] || '').trim()) w.push('Missing delivery location') } else if (!destLatCol.value || !(job[destLatCol.value] || '').trim()) w.push('Missing delivery coordinates')
  return w.length ? w.join('; ') : ''
}
const { page, pageSize, totalPages, paginatedItems, goTo, setSize } = usePagination(filteredJobs)
const brokerSourceCol = computed(() => props.headers.find(h => /broker/i.test(h)) || null)
const phoneSourceCol = computed(() => props.headers.find(h => /phone/i.test(h)) || null)
const displayCols = computed(() => {
  const cols = pickDisplayCols(props.headers, ['load', 'status', 'origin', 'pickup', 'destination', 'drop', 'rate', 'amount'])
  return cols.filter(c => c !== brokerSourceCol.value && c !== phoneSourceCol.value)
})
function parseJsonCell(r) { if (!r || typeof r !== 'string' || r[0] !== '{') return null; try { return JSON.parse(r) } catch { return null } }
function cellValue(job, col) { const v = job[col] || ''; const p = parseJsonCell(v); return p ? (p.Name || p.name || Object.values(p).filter(Boolean).join(' \u2022 ')) : v }
function pickDisplayCols(headers, keywords) { if (!headers || headers.length === 0) return []; const m = []; for (const k of keywords) { const c = headers.find(h => new RegExp(k, 'i').test(h) && !m.includes(h)); if (c) m.push(c) }; return m.length < 3 ? headers.slice(0, 8) : m }
function assign(job) { const d = assignSelections[job._rowIndex]; if (!d) { toast('Select a driver first', 'error'); return }; emit('assign', { rowIndex: job._rowIndex, driver: d, job }) }
</script>

<style scoped>
.grid-cols-2 { display: grid; grid-template-columns: 1fr 1fr; }
.col-span-2 { grid-column: 1 / -1; }
.font-mono { font-family: 'JetBrains Mono', monospace; }
</style>
