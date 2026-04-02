<template>
  <div>
    <div class="toolbar">
      <IconField>
        <InputIcon class="pi pi-search" />
        <InputText v-model="searchQuery" placeholder="Search load number..." size="small" />
      </IconField>
    </div>

    <div>
      <DataTable v-if="filteredJobs.length > 0" :value="paginatedItems" :rows="pageSize" striped-rows size="small" row-hover class="dash-table" @row-click="openDetail($event.data)">
        <Column v-for="col in displayCols" :key="col" :field="col" :header="col" sortable>
          <template #body="{ data }">
            <StatusBadge v-if="/status/i.test(col) && data[col]" :status="data[col]" />
            <template v-else>{{ cellValue(data, col) }}</template>
          </template>
        </Column>
        <Column header="Actions" :style="{ minWidth: '280px' }">
          <template #body="{ data }">
            <div class="actions-wrap" @click.stop>
              <div class="action-row">
                <Select v-model="statusSelections[data._rowIndex]" :options="statusOptions" :placeholder="getCurrentStatus(data) || 'Status'" size="small" class="action-sel" />
                <Button v-if="statusSelections[data._rowIndex]" label="Update" size="small" severity="info" @click="confirmStatusUpdate(data)" />
              </div>
              <div class="action-row">
                <Select v-model="reassignSelections[data._rowIndex]" :options="drivers" :placeholder="getCurrentDriver(data) || 'Driver'" size="small" class="action-sel" />
                <Button v-if="reassignSelections[data._rowIndex]" label="Reassign" size="small" @click="confirmReassign(data)" />
              </div>
              <Button label="Cancel" size="small" severity="danger" text @click="confirmCancel(data)" />
            </div>
          </template>
        </Column>
      </DataTable>
      <EmptyState v-else>{{ searchQuery ? 'No loads match your search.' : 'No active loads right now.' }}</EmptyState>
    </div>
    <PaginationBar :page="page" :page-size="pageSize" :total="filteredJobs.length" :total-pages="totalPages" @go="goTo" @size="setSize" />

    <!-- Detail Dialog -->
    <Dialog v-model:visible="showDetail" :header="loadIdValue || 'Load Details'" modal :style="{ width: '680px', maxWidth: '95vw' }" :dismissable-mask="true" @hide="closeDetail">
      <template v-if="selectedJob">
        <template v-for="section in detailSections" :key="section.title">
          <div v-if="section.fields.length" class="detail-section">
            <div class="section-label">{{ section.title }}</div>
            <div class="section-card">
              <div v-for="field in section.fields" :key="field.col" :class="['card-row', { 'full-width': field.wide }]">
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
          <div class="section-label">Documents</div>
          <div class="section-card" style="display:block">
            <div v-if="loadingDocs" class="doc-status">Loading documents...</div>
            <div v-else-if="loadDocs.length === 0" class="doc-status">No documents attached</div>
            <div v-else class="doc-items">
              <div v-for="doc in loadDocs" :key="doc.id" class="doc-row">
                <div class="doc-row-left">
                  <Tag :value="doc.type" :severity="docSeverity(doc.type)" />
                  <div class="doc-info">
                    <span class="doc-filename">{{ doc.file_name }}</span>
                    <span class="doc-date">{{ formatDocDate(doc.uploaded_at) }}</span>
                  </div>
                </div>
                <Button v-if="doc.drive_url" label="View" size="small" severity="secondary" @click="openPdfViewer(doc)" />
              </div>
            </div>
          </div>
        </div>

        <div class="detail-section">
          <div class="section-label">Route Map</div>
          <DriverRouteMap :load="selectedJob" :headers="headers" :driver-position="selectedDriverPosition" dispatch-mode />
        </div>
      </template>
    </Dialog>

    <!-- PDF Viewer -->
    <Dialog v-model:visible="showPdf" :header="pdfDoc?.file_name || 'Document'" modal :style="{ width: '90vw', maxWidth: '900px', height: '85vh' }" :dismissable-mask="true">
      <template v-if="pdfDoc">
        <div style="margin-bottom:0.5rem">
          <Tag :value="pdfDoc.type" :severity="docSeverity(pdfDoc.type)" />
          <a :href="pdfDoc.drive_url" target="_blank" rel="noopener" style="margin-left:0.5rem;font-size:0.8rem;">Open in New Tab</a>
        </div>
        <iframe :src="pdfEmbedUrl" style="width:100%;height:calc(85vh - 120px);border:none;border-radius:8px;" allowfullscreen></iframe>
      </template>
    </Dialog>
  </div>
</template>

<script setup>
import { computed, ref, reactive, watch } from 'vue'
import DataTable from 'primevue/datatable'
import Column from 'primevue/column'
import Dialog from 'primevue/dialog'
import Button from 'primevue/button'
import Select from 'primevue/select'
import SelectButton from 'primevue/selectbutton'
import InputText from 'primevue/inputtext'
import IconField from 'primevue/iconfield'
import InputIcon from 'primevue/inputicon'
import Tag from 'primevue/tag'
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
  try { driverLocations.value = (await api.get('/api/locations/latest')).locations || [] } catch {}
}
function onViewChange() { if (viewMode.value === 'map') fetchDriverLocations() }
watch(() => props.showMap, (v) => { if (v > 0) { viewMode.value = 'map'; fetchDriverLocations() } })

const emit = defineEmits(['reassign', 'cancel', 'status-update'])
const searchQuery = ref('')
const loadIdCol = computed(() => props.headers.find(h => /load.?id|job.?id/i.test(h)) || '')
const filteredJobs = computed(() => {
  const q = searchQuery.value.trim().toLowerCase()
  if (!q || !loadIdCol.value) return props.jobs
  return props.jobs.filter(j => (j[loadIdCol.value] || '').toString().toLowerCase().includes(q))
})
const { page, pageSize, totalPages, paginatedItems, goTo, setSize } = usePagination(filteredJobs)

const statusOptions = ['At Shipper', 'Loading', 'In Transit', 'At Receiver', 'Unloading', 'Delivered']
const selectedJob = ref(null)
const showDetail = ref(false)
const showPdf = ref(false)
const selectedDriverPosition = ref(null)
const reassignSelections = reactive({})
const statusSelections = reactive({})
const loadDocs = ref([])
const loadingDocs = ref(false)
const pdfDoc = ref(null)

const statusCol = computed(() => props.headers.find(h => /status/i.test(h)) || '')
const driverCol = computed(() => props.headers.find(h => /driver/i.test(h)) || '')
function getCurrentStatus(j) { return statusCol.value ? (j[statusCol.value] || '') : '' }
function getCurrentDriver(j) { return driverCol.value ? (j[driverCol.value] || '') : '' }

function confirmReassign(j) {
  const d = reassignSelections[j._rowIndex]; if (!d) return
  if (confirm(`Reassign this load to ${d}?`)) { emit('reassign', { rowIndex: j._rowIndex, newDriver: d, job: j }); reassignSelections[j._rowIndex] = '' }
}
function confirmCancel(j) { if (confirm('Cancel this assignment?')) emit('cancel', { rowIndex: j._rowIndex, job: j }) }
function confirmStatusUpdate(j) {
  const s = statusSelections[j._rowIndex]; if (!s) return
  if (confirm(`Update status to "${s}"?`)) { emit('status-update', { rowIndex: j._rowIndex, newStatus: s, job: j }); statusSelections[j._rowIndex] = '' }
}

function closeDetail() { selectedJob.value = null; selectedDriverPosition.value = null }
async function openDetail(job) {
  selectedJob.value = job; showDetail.value = true; selectedDriverPosition.value = null
  loadDocs.value = []; loadingDocs.value = true
  const dc = props.headers.find(h => /driver/i.test(h))
  const dn = dc ? (job[dc] || '').trim() : ''
  const lc = props.headers.find(h => /load.?id|job.?id/i.test(h))
  const lid = lc ? (job[lc] || '').trim() : ''
  const p = []
  if (dn) p.push(api.get('/api/locations/latest').then(d => { const l = (d.locations||[]).find(x => x.driver.toLowerCase() === dn.toLowerCase() && x.latitude); if (l) selectedDriverPosition.value = { latitude: l.latitude, longitude: l.longitude } }).catch(() => {}))
  if (lid) p.push(api.get(`/api/documents/${encodeURIComponent(lid)}`).then(r => { loadDocs.value = r.documents || [] }).catch(() => {}))
  await Promise.all(p); loadingDocs.value = false
}

function formatDocDate(s) { if (!s) return ''; const d = new Date(s); return isNaN(d) ? s : d.toLocaleDateString('en-US', { month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit' }) }
function docSeverity(t) { return t === 'POD' ? 'success' : t === 'Receipt' ? 'warn' : 'info' }
function openPdfViewer(doc) { pdfDoc.value = doc; showPdf.value = true }
const pdfEmbedUrl = computed(() => { if (!pdfDoc.value) return ''; const m = pdfDoc.value.drive_url.match(/drive\.google\.com\/file\/d\/([^/]+)/); return m ? `https://drive.google.com/file/d/${m[1]}/preview` : pdfDoc.value.drive_url })

const brokerSourceCol = computed(() => props.headers.find(h => /broker/i.test(h)) || null)
const phoneSourceCol = computed(() => props.headers.find(h => /phone/i.test(h)) || null)
const displayCols = computed(() => {
  const kw = ['load', 'status', 'driver', 'origin', 'pickup', 'destination', 'drop', 'rate', 'delivery']
  const m = []; for (const k of kw) { const c = props.headers.find(h => new RegExp(k, 'i').test(h) && !m.includes(h)); if (c) m.push(c) }
  return (m.length < 3 ? props.headers.slice(0, 8) : m).filter(c => c !== brokerSourceCol.value && c !== phoneSourceCol.value)
})

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
  if (!selectedJob.value) return []
  const used = new Set(); const secs = []
  for (const c of props.headers) { if (hiddenCols.test(c)) used.add(c) }
  for (const sp of sectionPatterns) { const f = []; for (const c of props.headers) { if (used.has(c)) continue; if (sp.test.test(c)) { used.add(c); f.push({ col: c, value: detailValue(selectedJob.value, c), wide: sp.wide ? sp.wide.test(c) : false }) } }; secs.push({ title: sp.title, fields: f }) }
  const rem = []; for (const c of props.headers) { if (used.has(c)) continue; rem.push({ col: c, value: detailValue(selectedJob.value, c), wide: false }) }
  if (rem.length) secs.push({ title: 'Other Details', fields: rem })
  return secs.filter(s => s.fields.length > 0)
})
</script>

<style scoped>
.toolbar { display: flex; align-items: center; gap: 0.75rem; padding: 0.5rem 1rem; border-bottom: 1px solid var(--border); flex-shrink: 0; }
.actions-wrap { display: flex; align-items: center; gap: 0.4rem; flex-wrap: nowrap; }
.action-row { display: flex; align-items: center; gap: 0.25rem; }
.action-sel { width: 130px; }
.detail-section { margin-bottom: 1.25rem; }
.detail-section:last-child { margin-bottom: 0; }
.section-label { font-size: 0.68rem; font-weight: 700; color: var(--text-dim); text-transform: uppercase; letter-spacing: 0.06em; margin-bottom: 0.5rem; }
.section-card { background: var(--surface); border: 1px solid var(--border); border-radius: 10px; display: grid; grid-template-columns: 1fr 1fr; overflow: hidden; }
.card-row { display: flex; flex-direction: column; gap: 0.15rem; padding: 0.7rem 1rem; border-bottom: 1px solid var(--border); }
.card-row.full-width { grid-column: 1 / -1; }
.card-row:last-child { border-bottom: none; }
.field-label { font-size: 0.68rem; font-weight: 600; color: var(--text-dim); text-transform: uppercase; letter-spacing: 0.02em; }
.field-value { font-size: 0.88rem; font-weight: 500; word-break: break-word; }
.doc-status { padding: 1rem; text-align: center; color: var(--text-dim); font-size: 0.82rem; }
.doc-items { padding: 0.5rem; }
.doc-row { display: flex; align-items: center; justify-content: space-between; padding: 0.5rem; border-bottom: 1px solid var(--border); }
.doc-row:last-child { border-bottom: none; }
.doc-row-left { display: flex; align-items: center; gap: 0.6rem; }
.doc-info { display: flex; flex-direction: column; }
.doc-filename { font-size: 0.82rem; font-weight: 500; }
.doc-date { font-size: 0.68rem; color: var(--text-dim); }
</style>
