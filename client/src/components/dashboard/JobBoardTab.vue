<template>
  <div>
    <div class="view-toggle">
      <button :class="['toggle-btn', { active: viewMode === 'list' }]" @click="viewMode = 'list'">List</button>
      <button :class="['toggle-btn', { active: viewMode === 'map' }]" @click="viewMode = 'map'">Map</button>
    </div>

    <LoadsMapView
      v-show="viewMode === 'map'"
      :loads="jobs"
      :headers="headers"
      category="unassigned"
      :visible="viewMode === 'map'"
    />

    <div v-show="viewMode === 'list'" class="table-scroll">
      <SkeletonLoader v-if="loading" />
      <table v-else-if="jobs.length > 0">
        <thead>
          <tr>
            <th v-for="col in displayCols" :key="col">{{ col }}</th>
            <th>Assign Driver</th>
          </tr>
        </thead>
        <tbody>
          <tr v-for="job in paginatedItems" :key="job._rowIndex" class="clickable-row" :class="{ 'warning-row': missingData(job) }" @click="openDetail(job)">
            <td v-for="(col, idx) in displayCols" :key="col">
              <span v-if="idx === 0 && missingData(job)" class="row-warning" :title="missingData(job)">&#9888;</span>
              <StatusBadge v-if="/status/i.test(col) && job[col]" :status="job[col]" />
              <template v-else>{{ cellValue(job, col) }}</template>
            </td>
            <td @click.stop>
              <div class="assign-cell">
                <select v-model="assignSelections[job._rowIndex]">
                  <option value="">Select driver</option>
                  <option v-for="d in drivers" :key="d" :value="d">{{ d }}</option>
                </select>
                <button class="btn btn-primary btn-sm" @click="assign(job)">Assign</button>
              </div>
            </td>
          </tr>
        </tbody>
      </table>
      <EmptyState v-else>All loads are assigned.</EmptyState>
    </div>
    <PaginationBar
      v-show="viewMode === 'list'"
      :page="page"
      :page-size="pageSize"
      :total="jobs.length"
      :total-pages="totalPages"
      @go="goTo"
      @size="setSize"
    />

    <!-- Load Detail Modal -->
    <Teleport to="body">
      <div v-if="selectedJob" class="modal-overlay" @click.self="selectedJob = null">
        <div class="detail-modal">
          <!-- Header with Load ID + Status -->
          <div class="modal-header">
            <div class="modal-title-row">
              <h3>{{ loadIdValue || 'Load Details' }}</h3>
              <StatusBadge v-if="statusValue" :status="statusValue" />
            </div>
            <button class="modal-close" @click="selectedJob = null">&times;</button>
          </div>

          <div class="modal-body">
            <!-- Grouped sections -->
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
                      <template v-else>{{ field.value || '—' }}</template>
                    </span>
                  </div>
                </div>
              </div>
            </template>

            <!-- Route Map -->
            <div class="detail-section">
              <div class="section-label">Route Map</div>
              <DriverRouteMap
                :load="selectedJob"
                :headers="headers"
                :driver-position="null"
                dispatch-mode
              />
            </div>
          </div>
        </div>
      </div>
    </Teleport>
  </div>
</template>

<script setup>
import { computed, reactive, ref, watch } from 'vue'
import { usePagination } from '../../composables/usePagination'
import { useToast } from '../../composables/useToast'
import { useAuthStore } from '../../stores/auth'
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

watch(() => props.showMap, (val) => {
  if (val > 0) viewMode.value = 'map'
})

const emit = defineEmits(['assign'])
const { show: toast } = useToast()
const auth = useAuthStore()

const assignSelections = reactive({})
const selectedJob = ref(null)

function openDetail(job) {
  selectedJob.value = job
}

function detailValue(job, col) {
  const val = job[col] || ''
  const parsed = parseJsonCell(val)
  if (parsed) {
    return Object.entries(parsed).filter(([, v]) => v).map(([k, v]) => `${k}: ${v}`).join(', ')
  }
  return val
}

// Section grouping patterns
const sectionPatterns = [
  { title: 'Load Information', test: /load|job|id|status|driver|truck|trailer|equipment|type|commodity|weight|miles|details/i, wide: /details|commodity/i },
  { title: 'Route', test: /origin|pickup|shipper|dest|drop|receiver|delivery|consignee|city|state|zip|address|location/i, wide: /address/i },
  { title: 'Schedule', test: /date|time|pickup.*date|delivery.*date|appointment|eta|scheduled/i },
  { title: 'Financials', test: /rate|amount|revenue|pay|charge|price|cost|invoice|total/i },
]

// Broker/contact columns to exclude from the detail modal
const hiddenCols = /broker|phone|email|contact/i

const loadIdValue = computed(() => {
  if (!selectedJob.value) return ''
  const col = props.headers.find(h => /load.?id|job.?id/i.test(h))
  return col ? selectedJob.value[col] || '' : ''
})

const statusValue = computed(() => {
  if (!selectedJob.value) return ''
  const col = props.headers.find(h => /^status$/i.test(h) || /load.*status/i.test(h))
  return col ? selectedJob.value[col] || '' : ''
})

const detailSections = computed(() => {
  if (!selectedJob.value) return []
  const used = new Set()
  const sections = []

  // Pre-mark broker/contact columns as used so they never appear
  for (const col of props.headers) {
    if (hiddenCols.test(col)) used.add(col)
  }

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

  // Remaining fields go into "Other Details"
  const remaining = []
  for (const col of props.headers) {
    if (used.has(col)) continue
    const val = detailValue(selectedJob.value, col)
    remaining.push({ col, value: val, wide: false })
  }
  if (remaining.length) {
    sections.push({ title: 'Other Details', fields: remaining })
  }

  return sections.filter(s => s.fields.length > 0)
})

// Detect address/coordinate columns for missing data warnings
const pickupAddrCol = computed(() => props.headers.find(h => /pickup.*addr/i.test(h)) || null)
const dropoffAddrCol = computed(() => props.headers.find(h => /drop.*addr/i.test(h)) || null)
const originLatCol = computed(() => props.headers.find(h => /origin.*lat|pickup.*lat|shipper.*lat/i.test(h)) || null)
const destLatCol = computed(() => props.headers.find(h => /dest.*lat|drop.*lat|receiver.*lat|delivery.*lat/i.test(h)) || null)

function missingData(job) {
  const warnings = []
  const pickupAddr = pickupAddrCol.value ? (job[pickupAddrCol.value] || '').trim() : ''
  const dropoffAddr = dropoffAddrCol.value ? (job[dropoffAddrCol.value] || '').trim() : ''
  const oLat = originLatCol.value ? (job[originLatCol.value] || '').trim() : ''
  const dLat = destLatCol.value ? (job[destLatCol.value] || '').trim() : ''

  if (!pickupAddr && !oLat) warnings.push('Missing pickup location')
  else if (!oLat) warnings.push('Missing pickup coordinates')

  if (!dropoffAddr && !dLat) warnings.push('Missing delivery location')
  else if (!dLat) warnings.push('Missing delivery coordinates')

  return warnings.length ? warnings.join('; ') : ''
}

const jobsRef = computed(() => props.jobs)
const { page, pageSize, totalPages, paginatedItems, goTo, setSize } = usePagination(jobsRef)

const brokerSourceCol = computed(() => props.headers.find(h => /broker/i.test(h)) || null)
const phoneSourceCol = computed(() => props.headers.find(h => /phone/i.test(h)) || null)

const displayCols = computed(() => {
  const cols = pickDisplayCols(props.headers, ['load', 'status', 'origin', 'pickup', 'destination', 'drop', 'rate', 'amount'])
  // Remove any broker/phone columns that slipped through
  return cols.filter(c => !brokerSourceCol.value || c !== brokerSourceCol.value)
             .filter(c => !phoneSourceCol.value || c !== phoneSourceCol.value)
})

function parseBrokerContact(raw) {
  if (!raw) return { name: '', email: '', phone: '' }
  try {
    const parsed = JSON.parse(raw)
    return { name: parsed.Name || '', email: parsed.Email || '', phone: parsed.Phone || '' }
  } catch {
    return { name: raw, email: '', phone: '' }
  }
}

function parseJsonCell(raw) {
  if (!raw || typeof raw !== 'string' || raw[0] !== '{') return null
  try {
    return JSON.parse(raw)
  } catch {
    return null
  }
}

function cellValue(job, col) {
  if ((col === 'Broker Name' || col === 'Broker Email') && brokerSourceCol.value) {
    const broker = parseBrokerContact(job[brokerSourceCol.value])
    return col === 'Broker Name' ? broker.name : broker.email
  }
  if (col === 'Broker Phone') {
    const src = phoneSourceCol.value || brokerSourceCol.value
    if (src) {
      const broker = parseBrokerContact(job[src])
      return broker.phone || ''
    }
  }
  const val = job[col] || ''
  const parsed = parseJsonCell(val)
  if (parsed) {
    return parsed.Name || parsed.name || Object.values(parsed).filter(Boolean).join(' \u2022 ')
  }
  return val
}

function pickDisplayCols(headers, keywords) {
  if (!headers || headers.length === 0) return []
  const matched = []
  for (const kw of keywords) {
    const re = new RegExp(kw, 'i')
    const col = headers.find((h) => re.test(h) && !matched.includes(h))
    if (col) matched.push(col)
  }
  if (matched.length < 3) return headers.slice(0, Math.min(8, headers.length))
  return matched
}

function assign(job) {
  const driver = assignSelections[job._rowIndex]
  if (!driver) {
    toast('Select a driver first', 'error')
    return
  }
  emit('assign', { rowIndex: job._rowIndex, driver, job })
}
</script>

<style scoped>
.view-toggle {
  display: flex;
  gap: 0;
  padding: 0.5rem 1rem;
  border-bottom: 1px solid var(--border);
  flex-shrink: 0;
}
.toggle-btn {
  padding: 0.3rem 0.75rem;
  border: 1px solid var(--border);
  background: transparent;
  font-family: 'DM Sans', sans-serif;
  font-size: 0.75rem;
  font-weight: 600;
  color: var(--text-dim);
  cursor: pointer;
  transition: all 0.15s;
}
.toggle-btn:first-child { border-radius: 5px 0 0 5px; }
.toggle-btn:last-child { border-radius: 0 5px 5px 0; border-left: none; }
.toggle-btn.active {
  background: var(--accent);
  color: #fff;
  border-color: var(--accent);
}

.clickable-row {
  cursor: pointer;
  transition: background 0.15s;
}
.clickable-row:hover {
  background: var(--surface-hover, rgba(0, 0, 0, 0.04));
}
.warning-row {
  background: rgba(234, 179, 8, 0.06);
}
.warning-row:hover {
  background: rgba(234, 179, 8, 0.12) !important;
}
.row-warning {
  color: #d97706;
  font-size: 0.9rem;
  margin-right: 0.35rem;
  cursor: help;
}

/* Modal overlay */
.modal-overlay {
  position: fixed;
  inset: 0;
  background: rgba(0, 0, 0, 0.4);
  z-index: 200;
  display: flex;
  align-items: center;
  justify-content: center;
  backdrop-filter: blur(2px);
}
.detail-modal {
  background: var(--bg, #f5f6fa);
  border-radius: 16px;
  width: 92%;
  max-width: 680px;
  max-height: 85vh;
  display: flex;
  flex-direction: column;
  box-shadow: 0 24px 80px rgba(0, 0, 0, 0.18);
  animation: modalIn 0.25s ease-out;
}
@keyframes modalIn {
  from { transform: translateY(16px) scale(0.96); opacity: 0; }
  to { transform: translateY(0) scale(1); opacity: 1; }
}

/* Header */
.modal-header {
  display: flex;
  align-items: center;
  justify-content: space-between;
  padding: 1.25rem 1.5rem;
  background: var(--surface, #fff);
  border-bottom: 1px solid var(--border);
  border-radius: 16px 16px 0 0;
  flex-shrink: 0;
}
.modal-title-row {
  display: flex;
  align-items: center;
  gap: 0.75rem;
}
.modal-header h3 {
  font-size: 1.1rem;
  font-weight: 700;
  margin: 0;
}
.modal-close {
  width: 32px;
  height: 32px;
  display: flex;
  align-items: center;
  justify-content: center;
  border: none;
  border-radius: 8px;
  background: transparent;
  color: var(--text-dim);
  font-size: 1.3rem;
  cursor: pointer;
  transition: all 0.12s;
  flex-shrink: 0;
}
.modal-close:hover {
  background: var(--surface-hover, rgba(0,0,0,0.06));
  color: var(--text);
}

/* Body */
.modal-body {
  padding: 1.25rem 1.5rem 1.5rem;
  overflow-y: auto;
  flex: 1;
}

/* Sections */
.detail-section {
  margin-bottom: 1.25rem;
}
.detail-section:last-child {
  margin-bottom: 0;
}
.section-label {
  font-size: 0.68rem;
  font-weight: 700;
  color: var(--text-dim, #8b8fa3);
  text-transform: uppercase;
  letter-spacing: 0.06em;
  margin-bottom: 0.5rem;
  padding-left: 0.15rem;
}
.section-card {
  background: var(--surface, #fff);
  border: 1px solid var(--border, #e5e7eb);
  border-radius: 10px;
  display: grid;
  grid-template-columns: 1fr 1fr;
  overflow: hidden;
}
.card-row {
  display: flex;
  flex-direction: column;
  gap: 0.15rem;
  padding: 0.7rem 1rem;
  border-bottom: 1px solid var(--border, #e5e7eb);
  min-width: 0;
}
.card-row.full-width {
  grid-column: 1 / -1;
}
/* Remove bottom border from last row(s) */
.section-card .card-row:last-child,
.section-card .card-row:nth-last-child(2):nth-child(odd) {
  border-bottom: none;
}
.field-label {
  font-size: 0.68rem;
  font-weight: 600;
  color: var(--text-dim, #8b8fa3);
  text-transform: uppercase;
  letter-spacing: 0.02em;
  line-height: 1;
}
.field-value {
  font-size: 0.88rem;
  font-weight: 500;
  color: var(--text, #1a1a2e);
  word-break: break-word;
  line-height: 1.35;
}

@media (max-width: 480px) {
  .detail-modal {
    width: 96%;
    max-height: 90vh;
    border-radius: 14px;
  }
  .modal-header {
    border-radius: 14px 14px 0 0;
  }
  .section-card {
    grid-template-columns: 1fr;
  }
  .card-row.full-width {
    grid-column: 1;
  }
  .modal-body {
    padding: 1rem;
  }
}
</style>
