<template>
  <div>
    <div class="view-toggle">
      <button :class="['toggle-btn', { active: viewMode === 'list' }]" @click="viewMode = 'list'">List</button>
      <button :class="['toggle-btn', { active: viewMode === 'map' }]" @click="switchToMap">Map</button>
    </div>

    <LoadsMapView
      v-show="viewMode === 'map'"
      :loads="jobs"
      :headers="headers"
      category="active"
      :driver-locations="driverLocations"
      :visible="viewMode === 'map'"
    />

    <div v-show="viewMode === 'list'" class="search-bar">
      <input v-model="searchQuery" type="text" placeholder="Search load number..." class="search-input" />
    </div>

    <div v-show="viewMode === 'list'" class="table-scroll">
      <table v-if="filteredJobs.length > 0">
        <thead>
          <tr>
            <th v-for="col in displayCols" :key="col">{{ col }}</th>
            <th>Actions</th>
          </tr>
        </thead>
        <tbody>
          <tr v-for="job in paginatedItems" :key="job._rowIndex" class="clickable-row" @click="openDetail(job)">
            <td v-for="col in displayCols" :key="col">
              <StatusBadge v-if="/status/i.test(col) && job[col]" :status="job[col]" />
              <template v-else>{{ cellValue(job, col) }}</template>
            </td>
            <td @click.stop>
              <div class="action-cell">
                <select :value="statusSelections[job._rowIndex] || ''" @change="statusSelections[job._rowIndex] = $event.target.value" class="action-select">
                  <option value="" disabled selected>{{ getCurrentStatus(job) || 'Update Status...' }}</option>
                  <option v-for="s in statusOptions" :key="s" :value="s">{{ s }}</option>
                </select>
                <button
                  v-if="statusSelections[job._rowIndex]"
                  class="btn btn-primary btn-sm"
                  @click="confirmStatusUpdate(job)"
                >Update</button>
              </div>
              <div class="action-cell" style="margin-top:0.3rem">
                <select :value="reassignSelections[job._rowIndex] || ''" @change="reassignSelections[job._rowIndex] = $event.target.value" class="action-select">
                  <option value="" disabled selected>{{ getCurrentDriver(job) || 'Reassign...' }}</option>
                  <option v-for="d in drivers" :key="d" :value="d">{{ d }}</option>
                </select>
                <button
                  v-if="reassignSelections[job._rowIndex]"
                  class="btn btn-primary btn-sm"
                  @click="confirmReassign(job)"
                >Reassign</button>
                <button class="btn btn-danger btn-sm" @click="confirmCancel(job)">Cancel</button>
              </div>
            </td>
          </tr>
        </tbody>
      </table>
      <EmptyState v-else>{{ searchQuery ? 'No loads match your search.' : 'No active loads right now.' }}</EmptyState>
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
    <Teleport to="body">
      <div v-if="selectedJob" class="modal-overlay" @click.self="closeDetail">
        <div class="detail-modal">
          <div class="modal-header">
            <div class="modal-title-row">
              <h3>{{ loadIdValue || 'Load Details' }}</h3>
              <StatusBadge v-if="statusValue" :status="statusValue" />
            </div>
            <button class="modal-close" @click="closeDetail">&times;</button>
          </div>

          <div class="modal-body">
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

            <!-- Documents -->
            <div class="detail-section">
              <div class="section-label">Documents</div>
              <div class="section-card" style="display:block">
                <div v-if="loadingDocs" class="doc-status">Loading documents...</div>
                <div v-else-if="loadDocs.length === 0" class="doc-status">No documents attached</div>
                <div v-else class="doc-items">
                  <div v-for="doc in loadDocs" :key="doc.id" class="doc-row">
                    <div class="doc-row-left">
                      <span :class="['doc-type-badge', `badge-${doc.type.toLowerCase()}`]">{{ doc.type }}</span>
                      <div class="doc-info">
                        <span class="doc-filename">{{ doc.file_name }}</span>
                        <span class="doc-date">{{ formatDocDate(doc.uploaded_at) }}</span>
                      </div>
                    </div>
                    <button v-if="doc.drive_url" class="doc-view-btn" @click="openPdfViewer(doc)">View</button>
                  </div>
                </div>
              </div>
            </div>

            <!-- Route Map -->
            <div class="detail-section">
              <div class="section-label">Route Map</div>
              <DriverRouteMap
                :load="selectedJob"
                :headers="headers"
                :driver-position="selectedDriverPosition"
                dispatch-mode
              />
            </div>
          </div>
        </div>
      </div>
    </Teleport>

    <!-- PDF Viewer Modal -->
    <Teleport to="body">
      <div v-if="pdfDoc" class="pdf-overlay" @click.self="pdfDoc = null">
        <div class="pdf-modal">
          <div class="pdf-header">
            <div class="pdf-title">
              <span :class="['doc-type-badge', `badge-${pdfDoc.type.toLowerCase()}`]">{{ pdfDoc.type }}</span>
              <span>{{ pdfDoc.file_name }}</span>
            </div>
            <div class="pdf-actions">
              <a :href="pdfDoc.drive_url" target="_blank" rel="noopener" class="pdf-open-btn">Open in New Tab</a>
              <button class="modal-close" @click="pdfDoc = null">&times;</button>
            </div>
          </div>
          <div class="pdf-body">
            <iframe :src="pdfEmbedUrl" class="pdf-frame" allowfullscreen></iframe>
          </div>
        </div>
      </div>
    </Teleport>
  </div>
</template>

<script setup>
import { computed, ref, reactive, watch } from 'vue'
import { usePagination } from '../../composables/usePagination'
import { useApi } from '../../composables/useApi'
import StatusBadge from '../shared/StatusBadge.vue'
import EmptyState from '../shared/EmptyState.vue'
import PaginationBar from '../shared/PaginationBar.vue'
import DriverRouteMap from '../driver/DriverRouteMap.vue'
import LoadsMapView from './LoadsMapView.vue'

const api = useApi()

const props = defineProps({
  jobs: { type: Array, required: true },
  headers: { type: Array, required: true },
  drivers: { type: Array, default: () => [] },
  showMap: { type: Number, default: 0 },
})

const viewMode = ref('list')
const driverLocations = ref([])

async function fetchDriverLocations() {
  try {
    const data = await api.get('/api/locations/latest')
    driverLocations.value = data.locations || []
  } catch { /* silent */ }
}

function switchToMap() {
  viewMode.value = 'map'
  fetchDriverLocations()
}

watch(() => props.showMap, (val) => {
  if (val > 0) switchToMap()
})

const emit = defineEmits(['reassign', 'cancel', 'status-update'])

const searchQuery = ref('')
const loadIdCol = computed(() => props.headers.find(h => /load.?id|job.?id/i.test(h)) || '')

const filteredJobs = computed(() => {
  const q = searchQuery.value.trim().toLowerCase()
  if (!q || !loadIdCol.value) return props.jobs
  return props.jobs.filter(job => {
    const val = (job[loadIdCol.value] || '').toString().toLowerCase()
    return val.includes(q)
  })
})

const { page, pageSize, totalPages, paginatedItems, goTo, setSize } = usePagination(filteredJobs)

const statusOptions = ['At Shipper', 'Loading', 'In Transit', 'At Receiver', 'Unloading', 'Delivered']

const selectedJob = ref(null)
const selectedDriverPosition = ref(null)
const reassignSelections = reactive({})
const statusSelections = reactive({})
const loadDocs = ref([])
const loadingDocs = ref(false)
const pdfDoc = ref(null)

const statusCol = computed(() => props.headers.find(h => /status/i.test(h)) || '')
const driverCol = computed(() => props.headers.find(h => /driver/i.test(h)) || '')

function getCurrentStatus(job) {
  return statusCol.value ? (job[statusCol.value] || '') : ''
}
function getCurrentDriver(job) {
  return driverCol.value ? (job[driverCol.value] || '') : ''
}

function confirmReassign(job) {
  const newDriver = reassignSelections[job._rowIndex]
  if (!newDriver) return
  if (confirm(`Reassign this load to ${newDriver}?`)) {
    emit('reassign', { rowIndex: job._rowIndex, newDriver, job })
    reassignSelections[job._rowIndex] = ''
  }
}

function confirmCancel(job) {
  if (confirm('Cancel this assignment? The load will be moved back to the Job Board.')) {
    emit('cancel', { rowIndex: job._rowIndex, job })
  }
}

function confirmStatusUpdate(job) {
  const newStatus = statusSelections[job._rowIndex]
  if (!newStatus) return
  if (confirm(`Update status to "${newStatus}"?`)) {
    emit('status-update', { rowIndex: job._rowIndex, newStatus, job })
    statusSelections[job._rowIndex] = ''
  }
}

function closeDetail() {
  selectedJob.value = null
  selectedDriverPosition.value = null
}

async function openDetail(job) {
  selectedJob.value = job
  selectedDriverPosition.value = null
  loadDocs.value = []
  loadingDocs.value = true

  const driverCol = props.headers.find(h => /driver/i.test(h))
  const driverName = driverCol ? (job[driverCol] || '').trim() : ''

  // Fetch driver location and documents in parallel
  const lidCol = props.headers.find(h => /load.?id|job.?id/i.test(h))
  const loadId = lidCol ? (job[lidCol] || '').trim() : ''

  const promises = []
  if (driverName) {
    promises.push(
      api.get('/api/locations/latest').then(data => {
        const loc = (data.locations || []).find(
          l => l.driver.toLowerCase() === driverName.toLowerCase() && l.latitude
        )
        if (loc) selectedDriverPosition.value = { latitude: loc.latitude, longitude: loc.longitude }
      }).catch(() => {})
    )
  }
  if (loadId) {
    promises.push(
      api.get(`/api/documents/${encodeURIComponent(loadId)}`).then(res => {
        loadDocs.value = res.documents || []
      }).catch(() => {})
    )
  }
  await Promise.all(promises)
  loadingDocs.value = false
}

function formatDocDate(str) {
  if (!str) return ''
  const d = new Date(str)
  if (isNaN(d)) return str
  return d.toLocaleDateString('en-US', { month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit' })
}

function openPdfViewer(doc) {
  pdfDoc.value = doc
}

const pdfEmbedUrl = computed(() => {
  if (!pdfDoc.value) return ''
  const url = pdfDoc.value.drive_url
  const driveMatch = url.match(/drive\.google\.com\/file\/d\/([^/]+)/)
  if (driveMatch) {
    return `https://drive.google.com/file/d/${driveMatch[1]}/preview`
  }
  return url
})

const brokerSourceCol = computed(() => props.headers.find(h => /broker/i.test(h)) || null)
const phoneSourceCol = computed(() => props.headers.find(h => /phone/i.test(h)) || null)

const displayCols = computed(() => {
  const keywords = ['load', 'status', 'driver', 'origin', 'pickup', 'destination', 'drop', 'rate', 'delivery']
  const matched = []
  for (const kw of keywords) {
    const re = new RegExp(kw, 'i')
    const col = props.headers.find((h) => re.test(h) && !matched.includes(h))
    if (col) matched.push(col)
  }
  if (matched.length < 3) return props.headers.slice(0, Math.min(8, props.headers.length))
  return matched.filter(c => !brokerSourceCol.value || c !== brokerSourceCol.value)
                .filter(c => !phoneSourceCol.value || c !== phoneSourceCol.value)
})

function parseJsonCell(raw) {
  if (!raw || typeof raw !== 'string' || raw[0] !== '{') return null
  try {
    return JSON.parse(raw)
  } catch {
    return null
  }
}

function cellValue(job, col) {
  const val = job[col] || ''
  const parsed = parseJsonCell(val)
  if (parsed) {
    return parsed.Name || parsed.name || Object.values(parsed).filter(Boolean).join(' \u2022 ')
  }
  return val
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

const hiddenCols = /broker|phone|email|contact|contract/i

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

  const remaining = []
  for (const col of props.headers) {
    if (used.has(col)) continue
    remaining.push({ col, value: detailValue(selectedJob.value, col), wide: false })
  }
  if (remaining.length) {
    sections.push({ title: 'Other Details', fields: remaining })
  }

  return sections.filter(s => s.fields.length > 0)
})
</script>

<style scoped>
.search-bar {
  padding: 0.5rem 1rem;
}
.search-input {
  width: 100%;
  max-width: 280px;
  padding: 0.4rem 0.75rem;
  border: 1px solid var(--border);
  border-radius: 6px;
  background: var(--surface, #fff);
  color: var(--text);
  font-family: 'DM Sans', sans-serif;
  font-size: 0.82rem;
  outline: none;
  transition: border-color 0.15s;
}
.search-input:focus {
  border-color: var(--accent);
}
.search-input::placeholder {
  color: var(--text-dim);
}
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

/* Documents */
.doc-status {
  text-align: center;
  font-size: 0.8rem;
  color: var(--text-dim);
  padding: 0.75rem 1rem;
}
.doc-items {
  display: flex;
  flex-direction: column;
}
.doc-row {
  display: flex;
  align-items: center;
  justify-content: space-between;
  padding: 0.6rem 1rem;
  border-bottom: 1px solid var(--border, #e5e7eb);
  gap: 0.5rem;
}
.doc-row:last-child { border-bottom: none; }
.doc-row-left {
  display: flex;
  align-items: center;
  gap: 0.5rem;
  min-width: 0;
  flex: 1;
}
.doc-type-badge {
  font-size: 0.6rem;
  font-weight: 700;
  text-transform: uppercase;
  letter-spacing: 0.04em;
  padding: 0.15rem 0.4rem;
  border-radius: 4px;
  flex-shrink: 0;
}
.badge-pod { background: #dcfce7; color: #166534; }
.badge-receipt { background: #fef9c3; color: #854d0e; }
.badge-bol { background: #dbeafe; color: #1e40af; }
.badge-other { background: var(--bg); color: var(--text-dim); border: 1px solid var(--border); }
.doc-info {
  display: flex;
  flex-direction: column;
  min-width: 0;
}
.doc-filename {
  font-size: 0.78rem;
  font-weight: 500;
  color: var(--text);
  white-space: nowrap;
  overflow: hidden;
  text-overflow: ellipsis;
}
.doc-date {
  font-size: 0.65rem;
  color: var(--text-dim);
}
.doc-view-btn {
  font-size: 0.75rem;
  font-weight: 600;
  color: var(--accent);
  background: none;
  border: none;
  cursor: pointer;
  flex-shrink: 0;
  font-family: inherit;
  padding: 0.2rem 0.4rem;
  border-radius: 4px;
  transition: background 0.12s;
}
.doc-view-btn:hover {
  background: rgba(0, 0, 0, 0.04);
  text-decoration: underline;
}

/* PDF Viewer Modal */
.pdf-overlay {
  position: fixed;
  inset: 0;
  background: rgba(0, 0, 0, 0.6);
  z-index: 300;
  display: flex;
  align-items: center;
  justify-content: center;
  backdrop-filter: blur(3px);
}
.pdf-modal {
  background: var(--bg, #f5f6fa);
  border-radius: 14px;
  width: 94%;
  max-width: 900px;
  height: 85vh;
  display: flex;
  flex-direction: column;
  box-shadow: 0 24px 80px rgba(0, 0, 0, 0.25);
  animation: modalIn 0.25s ease-out;
}
.pdf-header {
  display: flex;
  align-items: center;
  justify-content: space-between;
  padding: 0.75rem 1.25rem;
  background: var(--surface, #fff);
  border-bottom: 1px solid var(--border);
  border-radius: 14px 14px 0 0;
  flex-shrink: 0;
  gap: 0.75rem;
}
.pdf-title {
  display: flex;
  align-items: center;
  gap: 0.5rem;
  font-size: 0.85rem;
  font-weight: 600;
  min-width: 0;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}
.pdf-actions {
  display: flex;
  align-items: center;
  gap: 0.5rem;
  flex-shrink: 0;
}
.pdf-open-btn {
  font-size: 0.72rem;
  font-weight: 600;
  color: var(--accent);
  text-decoration: none;
  padding: 0.3rem 0.6rem;
  border-radius: 6px;
  border: 1px solid var(--accent);
  transition: all 0.12s;
  white-space: nowrap;
}
.pdf-open-btn:hover {
  background: var(--accent);
  color: #fff;
}
.pdf-body {
  flex: 1;
  min-height: 0;
  border-radius: 0 0 14px 14px;
  overflow: hidden;
}
.pdf-frame {
  width: 100%;
  height: 100%;
  border: none;
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
  .pdf-modal {
    width: 98%;
    height: 90vh;
    border-radius: 10px;
  }
  .pdf-header {
    border-radius: 10px 10px 0 0;
    padding: 0.6rem 0.75rem;
  }
  .pdf-body {
    border-radius: 0 0 10px 10px;
  }
}

.action-cell {
  display: flex;
  align-items: center;
  gap: 0.35rem;
  white-space: nowrap;
}
.action-select {
  padding: 0.25rem 0.4rem;
  background: var(--bg);
  border: 1px solid var(--border);
  border-radius: 4px;
  color: var(--text);
  font-family: 'DM Sans', sans-serif;
  font-size: 0.78rem;
  outline: none;
  min-width: 110px;
}
.btn-sm {
  padding: 0.25rem 0.55rem;
  font-size: 0.72rem;
  font-weight: 600;
  border: none;
  border-radius: 4px;
  cursor: pointer;
  font-family: inherit;
}
.btn-primary {
  background: var(--accent);
  color: #fff;
}
.btn-danger {
  background: var(--danger, #ef4444);
  color: #fff;
}
</style>
