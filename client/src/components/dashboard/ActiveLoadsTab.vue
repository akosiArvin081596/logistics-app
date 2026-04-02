<template>
  <div>
    <div class="flex align-items-center gap-3 p-2 border-bottom-1 surface-border">
      <IconField>
        <InputIcon class="pi pi-search" />
        <InputText v-model="searchQuery" placeholder="Search load number..." size="small" />
      </IconField>
    </div>

    <div>
      <DataTable v-if="filteredJobs.length > 0" :value="paginatedItems" :rows="pageSize" size="small" row-hover @row-click="openDetail($event.data)">
        <Column v-for="col in displayCols" :key="col" :field="col" :header="col" sortable>
          <template #body="{ data }">
            <StatusBadge v-if="/status/i.test(col) && data[col]" :status="data[col]" />
            <template v-else>{{ cellValue(data, col) }}</template>
          </template>
        </Column>
        <Column header="Actions" :style="{ minWidth: '320px' }">
          <template #body="{ data }">
            <div class="flex align-items-center gap-2 flex-wrap" @click.stop>
              <Select v-model="statusSelections[data._rowIndex]" :options="statusOptions" :placeholder="getCurrentStatus(data) || 'Status'" size="small" style="width:120px;" />
              <Button v-if="statusSelections[data._rowIndex]" label="Update" size="small" severity="info" @click="confirmStatusUpdate(data)" />
              <Select v-model="reassignSelections[data._rowIndex]" :options="drivers" :placeholder="getCurrentDriver(data) || 'Driver'" size="small" style="width:130px;" />
              <Button v-if="reassignSelections[data._rowIndex]" label="Reassign" size="small" @click="confirmReassign(data)" />
              <Button icon="pi pi-times" size="small" severity="danger" text rounded @click="confirmCancel(data)" v-tooltip.top="'Cancel'" />
            </div>
          </template>
        </Column>
      </DataTable>
      <EmptyState v-else>{{ searchQuery ? 'No loads match your search.' : 'No active loads right now.' }}</EmptyState>
    </div>
    <PaginationBar :page="page" :page-size="pageSize" :total="filteredJobs.length" :total-pages="totalPages" @go="goTo" @size="setSize" />

    <Dialog v-model:visible="showDetail" :header="loadIdValue || 'Load Details'" modal :style="{ width: '680px', maxWidth: '95vw' }" :dismissable-mask="true" @hide="closeDetail">
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
          <div class="text-xs font-bold text-color-secondary uppercase mb-2" style="letter-spacing:0.06em;">Documents</div>
          <div class="surface-card border-1 surface-border border-round-lg p-3">
            <div v-if="loadingDocs" class="text-center text-color-secondary text-sm p-3">Loading documents...</div>
            <div v-else-if="loadDocs.length === 0" class="text-center text-color-secondary text-sm p-3">No documents attached</div>
            <div v-else class="flex flex-column gap-2">
              <div v-for="doc in loadDocs" :key="doc.id" class="flex align-items-center justify-content-between p-2 border-bottom-1 surface-border">
                <div class="flex align-items-center gap-2">
                  <Tag :value="doc.type" :severity="docSeverity(doc.type)" />
                  <div class="flex flex-column">
                    <span class="text-sm font-medium">{{ doc.file_name }}</span>
                    <span class="text-xs text-color-secondary">{{ formatDocDate(doc.uploaded_at) }}</span>
                  </div>
                </div>
                <Button v-if="doc.drive_url" label="View" size="small" severity="secondary" @click="openPdfViewer(doc)" />
              </div>
            </div>
          </div>
        </div>

        <div class="mb-3">
          <div class="text-xs font-bold text-color-secondary uppercase mb-2" style="letter-spacing:0.06em;">Route Map</div>
          <DriverRouteMap :load="selectedJob" :headers="headers" :driver-position="selectedDriverPosition" dispatch-mode />
        </div>
      </template>
    </Dialog>

    <Dialog v-model:visible="showPdf" :header="pdfDoc?.file_name || 'Document'" modal :style="{ width: '90vw', maxWidth: '900px', height: '85vh' }" :dismissable-mask="true">
      <template v-if="pdfDoc">
        <div class="mb-2">
          <Tag :value="pdfDoc.type" :severity="docSeverity(pdfDoc.type)" />
          <a :href="pdfDoc.drive_url" target="_blank" rel="noopener" class="ml-2 text-sm">Open in New Tab</a>
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
import InputText from 'primevue/inputtext'
import IconField from 'primevue/iconfield'
import InputIcon from 'primevue/inputicon'
import Tag from 'primevue/tag'
import Tooltip from 'primevue/tooltip'
import { usePagination } from '../../composables/usePagination'
import { useApi } from '../../composables/useApi'
import StatusBadge from '../shared/StatusBadge.vue'
import EmptyState from '../shared/EmptyState.vue'
import PaginationBar from '../shared/PaginationBar.vue'
import DriverRouteMap from '../driver/DriverRouteMap.vue'

const vTooltip = Tooltip
const api = useApi()

const props = defineProps({
  jobs: { type: Array, required: true },
  headers: { type: Array, required: true },
  drivers: { type: Array, default: () => [] },
  showMap: { type: Number, default: 0 },
})

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
function confirmReassign(j) { const d = reassignSelections[j._rowIndex]; if (!d) return; if (confirm(`Reassign to ${d}?`)) { emit('reassign', { rowIndex: j._rowIndex, newDriver: d, job: j }); reassignSelections[j._rowIndex] = '' } }
function confirmCancel(j) { if (confirm('Cancel this assignment?')) emit('cancel', { rowIndex: j._rowIndex, job: j }) }
function confirmStatusUpdate(j) { const s = statusSelections[j._rowIndex]; if (!s) return; if (confirm(`Update to "${s}"?`)) { emit('status-update', { rowIndex: j._rowIndex, newStatus: s, job: j }); statusSelections[j._rowIndex] = '' } }
function closeDetail() { selectedJob.value = null; selectedDriverPosition.value = null }
async function openDetail(job) {
  selectedJob.value = job; showDetail.value = true; selectedDriverPosition.value = null; loadDocs.value = []; loadingDocs.value = true
  const dc = props.headers.find(h => /driver/i.test(h)); const dn = dc ? (job[dc] || '').trim() : ''
  const lc = props.headers.find(h => /load.?id|job.?id/i.test(h)); const lid = lc ? (job[lc] || '').trim() : ''
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
.grid-cols-2 { display: grid; grid-template-columns: 1fr 1fr; }
.col-span-2 { grid-column: 1 / -1; }
</style>
