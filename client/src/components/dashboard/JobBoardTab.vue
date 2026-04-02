<template>
  <div>
    <div class="toolbar">
      <SelectButton v-model="viewMode" :options="viewOptions" option-label="label" option-value="value" :allow-empty="false" />
      <IconField v-show="viewMode === 'list'">
        <InputIcon class="pi pi-search" />
        <InputText v-model="searchQuery" placeholder="Search load number..." size="small" />
      </IconField>
    </div>

    <LoadsMapView
      v-show="viewMode === 'map'"
      :loads="jobs"
      :headers="headers"
      category="unassigned"
      :visible="viewMode === 'map'"
    />

    <div v-show="viewMode === 'list'">
      <SkeletonLoader v-if="loading" />
      <DataTable
        v-else-if="filteredJobs.length > 0"
        :value="paginatedItems"
        :rows="pageSize"
        striped-rows
        size="small"
        row-hover
        class="dash-table"
        @row-click="openDetail($event.data)"
      >
        <Column v-for="col in displayCols" :key="col" :field="col" :header="col" sortable>
          <template #body="{ data }">
            <StatusBadge v-if="/status/i.test(col)" :status="data[col] || 'Unassigned'" />
            <span v-else-if="missingData(data) && displayCols.indexOf(col) === 0">
              <i class="pi pi-exclamation-triangle" style="color:#d97706;margin-right:0.3rem;" :title="missingData(data)"></i>
              {{ cellValue(data, col) }}
            </span>
            <template v-else>{{ cellValue(data, col) }}</template>
          </template>
        </Column>
        <Column header="Assign Driver" :style="{ minWidth: '200px' }">
          <template #body="{ data }">
            <div v-if="!hideAssign(data)" class="assign-cell" @click.stop>
              <Select v-model="assignSelections[data._rowIndex]" :options="drivers" placeholder="Select driver" size="small" class="assign-select" />
              <Button label="Assign" size="small" @click.stop="assign(data)" />
            </div>
            <span v-else class="text-dim">&mdash;</span>
          </template>
        </Column>
      </DataTable>
      <EmptyState v-else>{{ searchQuery ? 'No loads match your search.' : 'All loads are assigned.' }}</EmptyState>
    </div>
    <PaginationBar
      v-show="viewMode === 'list'"
      :page="page"
      :page-size="pageSize"
      :total="filteredJobs.length"
      :total-pages="totalPages"
      @go="goTo"
      @size="setSize"
    />

    <!-- Load Detail Modal -->
    <Dialog v-model:visible="showDetail" :header="loadIdValue || 'Load Details'" modal :style="{ width: '680px', maxWidth: '95vw' }" :dismissable-mask="true">
      <template v-if="selectedJob">
        <template v-for="section in detailSections" :key="section.title">
          <div v-if="section.fields.length" class="detail-section">
            <div class="section-label">{{ section.title }}</div>
            <div class="section-card">
              <div
                v-for="field in section.fields"
                :key="field.col"
                :class="['card-row', { 'full-width': field.wide }]"
              >
                <span class="field-label">{{ field.col }}</span>
                <span class="field-value">
                  <StatusBadge v-if="/status/i.test(field.col) && field.value" :status="field.value" />
                  <template v-else>{{ field.value || '\u2014' }}</template>
                </span>
              </div>
            </div>
          </div>
        </template>
        <div class="detail-section">
          <div class="section-label">Route Map</div>
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
import SelectButton from 'primevue/selectbutton'
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
import LoadsMapView from './LoadsMapView.vue'

const props = defineProps({
  jobs: { type: Array, required: true },
  drivers: { type: Array, required: true },
  headers: { type: Array, required: true },
  loading: { type: Boolean, default: false },
  showMap: { type: Number, default: 0 },
})

const viewMode = ref('list')
const viewOptions = [{ label: 'List', value: 'list' }, { label: 'Map', value: 'map' }]

watch(() => props.showMap, (val) => { if (val > 0) viewMode.value = 'map' })

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

function openDetail(job) {
  selectedJob.value = job
  showDetail.value = true
}

function detailValue(job, col) {
  const val = job[col] || ''
  const parsed = parseJsonCell(val)
  if (parsed) return Object.entries(parsed).filter(([, v]) => v).map(([k, v]) => `${k}: ${v}`).join(', ')
  return val
}

const sectionPatterns = [
  { title: 'Load Information', test: /load|job|id|status|driver|truck|trailer|equipment|type|commodity|weight|miles|details/i, wide: /details|commodity/i },
  { title: 'Route', test: /origin|pickup|shipper|dest|drop|receiver|delivery|consignee|city|state|zip|address|location/i, wide: /address/i },
  { title: 'Schedule', test: /date|time|pickup.*date|delivery.*date|appointment|eta|scheduled/i },
  { title: 'Financials', test: /rate|amount|revenue|pay|charge|price|cost|invoice|total/i },
]

const hiddenCols = /broker|phone|email|contact|contract/i

const loadIdValue = computed(() => {
  if (!selectedJob.value) return ''
  const col = props.headers.find(h => /load.?id|job.?id/i.test(h))
  return col ? selectedJob.value[col] || '' : ''
})

const detailSections = computed(() => {
  if (!selectedJob.value) return []
  const used = new Set()
  const sections = []
  for (const col of props.headers) { if (hiddenCols.test(col)) used.add(col) }
  for (const sp of sectionPatterns) {
    const fields = []
    for (const col of props.headers) {
      if (used.has(col)) continue
      if (sp.test.test(col)) {
        used.add(col)
        fields.push({ col, value: detailValue(selectedJob.value, col), wide: sp.wide ? sp.wide.test(col) : false })
      }
    }
    sections.push({ title: sp.title, fields })
  }
  const remaining = []
  for (const col of props.headers) {
    if (used.has(col)) continue
    remaining.push({ col, value: detailValue(selectedJob.value, col), wide: false })
  }
  if (remaining.length) sections.push({ title: 'Other Details', fields: remaining })
  return sections.filter(s => s.fields.length > 0)
})

const pickupAddrCol = computed(() => props.headers.find(h => /pickup.*addr/i.test(h)) || null)
const dropoffAddrCol = computed(() => props.headers.find(h => /drop.*addr/i.test(h)) || null)
const originLatCol = computed(() => props.headers.find(h => /origin.*lat|pickup.*lat|shipper.*lat/i.test(h)) || null)
const destLatCol = computed(() => props.headers.find(h => /dest.*lat|drop.*lat|receiver.*lat|delivery.*lat/i.test(h)) || null)

function missingData(job) {
  const warnings = []
  if (!pickupAddrCol.value || !(job[pickupAddrCol.value] || '').trim()) {
    if (!originLatCol.value || !(job[originLatCol.value] || '').trim()) warnings.push('Missing pickup location')
  } else if (!originLatCol.value || !(job[originLatCol.value] || '').trim()) {
    warnings.push('Missing pickup coordinates')
  }
  if (!dropoffAddrCol.value || !(job[dropoffAddrCol.value] || '').trim()) {
    if (!destLatCol.value || !(job[destLatCol.value] || '').trim()) warnings.push('Missing delivery location')
  } else if (!destLatCol.value || !(job[destLatCol.value] || '').trim()) {
    warnings.push('Missing delivery coordinates')
  }
  return warnings.length ? warnings.join('; ') : ''
}

const { page, pageSize, totalPages, paginatedItems, goTo, setSize } = usePagination(filteredJobs)

const brokerSourceCol = computed(() => props.headers.find(h => /broker/i.test(h)) || null)
const phoneSourceCol = computed(() => props.headers.find(h => /phone/i.test(h)) || null)

const displayCols = computed(() => {
  const cols = pickDisplayCols(props.headers, ['load', 'status', 'origin', 'pickup', 'destination', 'drop', 'rate', 'amount'])
  return cols.filter(c => c !== brokerSourceCol.value && c !== phoneSourceCol.value)
})

function parseJsonCell(raw) {
  if (!raw || typeof raw !== 'string' || raw[0] !== '{') return null
  try { return JSON.parse(raw) } catch { return null }
}

function parseBrokerContact(raw) {
  if (!raw) return { name: '', email: '', phone: '' }
  try { const p = JSON.parse(raw); return { name: p.Name || '', email: p.Email || '', phone: p.Phone || '' } }
  catch { return { name: raw, email: '', phone: '' } }
}

function cellValue(job, col) {
  if ((col === 'Broker Name' || col === 'Broker Email') && brokerSourceCol.value) {
    const b = parseBrokerContact(job[brokerSourceCol.value])
    return col === 'Broker Name' ? b.name : b.email
  }
  if (col === 'Broker Phone') {
    const src = phoneSourceCol.value || brokerSourceCol.value
    if (src) return parseBrokerContact(job[src]).phone || ''
  }
  const val = job[col] || ''
  const parsed = parseJsonCell(val)
  if (parsed) return parsed.Name || parsed.name || Object.values(parsed).filter(Boolean).join(' \u2022 ')
  return val
}

function pickDisplayCols(headers, keywords) {
  if (!headers || headers.length === 0) return []
  const matched = []
  for (const kw of keywords) {
    const re = new RegExp(kw, 'i')
    const col = headers.find(h => re.test(h) && !matched.includes(h))
    if (col) matched.push(col)
  }
  return matched.length < 3 ? headers.slice(0, Math.min(8, headers.length)) : matched
}

function assign(job) {
  const driver = assignSelections[job._rowIndex]
  if (!driver) { toast('Select a driver first', 'error'); return }
  emit('assign', { rowIndex: job._rowIndex, driver, job })
}
</script>

<style scoped>
.toolbar {
  display: flex; align-items: center; gap: 0.75rem;
  padding: 0.5rem 1rem; border-bottom: 1px solid var(--border); flex-shrink: 0;
}
.assign-cell { display: flex; align-items: center; gap: 0.4rem; }
.assign-select { min-width: 140px; }
.text-dim { color: var(--text-dim); }

/* Detail modal sections */
.detail-section { margin-bottom: 1.25rem; }
.detail-section:last-child { margin-bottom: 0; }
.section-label {
  font-size: 0.68rem; font-weight: 700; color: var(--text-dim);
  text-transform: uppercase; letter-spacing: 0.06em; margin-bottom: 0.5rem;
}
.section-card {
  background: var(--surface); border: 1px solid var(--border);
  border-radius: 10px; display: grid; grid-template-columns: 1fr 1fr; overflow: hidden;
}
.card-row {
  display: flex; flex-direction: column; gap: 0.15rem;
  padding: 0.7rem 1rem; border-bottom: 1px solid var(--border);
}
.card-row.full-width { grid-column: 1 / -1; }
.card-row:last-child { border-bottom: none; }
.field-label { font-size: 0.68rem; font-weight: 600; color: var(--text-dim); text-transform: uppercase; letter-spacing: 0.02em; }
.field-value { font-size: 0.88rem; font-weight: 500; word-break: break-word; }
</style>
