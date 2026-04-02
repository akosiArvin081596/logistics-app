<template>
  <div>
    <div class="dash-search-bar">
      <input v-model="searchQuery" type="text" placeholder="Search load number..." class="dash-search-input" />
    </div>

    <div class="overflow-x-auto">
      <table v-if="filteredJobs.length > 0" class="dash-table">
        <thead>
          <tr>
            <th v-for="col in displayCols" :key="col">{{ col }}</th>
            <th style="min-width:300px;">Actions</th>
          </tr>
        </thead>
        <tbody>
          <tr v-for="job in paginatedItems" :key="job._rowIndex" @click="openDetail(job)">
            <td v-for="col in displayCols" :key="col">
              <StatusBadge v-if="/status/i.test(col) && job[col]" :status="job[col]" />
              <template v-else>{{ cellValue(job, col) }}</template>
            </td>
            <td @click.stop>
              <div style="display:flex;align-items:center;gap:0.5rem;flex-wrap:nowrap;">
                <div style="display:flex;align-items:center;gap:0.25rem;flex-shrink:0;">
                  <select v-model="statusSelections[job._rowIndex]" class="dash-select dash-select-sm" style="width:108px">
                    <option value="">{{ getCurrentStatus(job) || 'Status' }}</option>
                    <option v-for="s in statusOptions" :key="s" :value="s">{{ s }}</option>
                  </select>
                  <button v-if="statusSelections[job._rowIndex]" class="dash-go-btn" @click="confirmStatusUpdate(job)">Go</button>
                </div>
                <div style="display:flex;align-items:center;gap:0.25rem;flex-shrink:0;">
                  <select v-model="reassignSelections[job._rowIndex]" class="dash-select dash-select-sm" style="width:118px">
                    <option value="">{{ getCurrentDriver(job) || 'Driver' }}</option>
                    <option v-for="d in drivers" :key="d" :value="d">{{ d }}</option>
                  </select>
                  <button v-if="reassignSelections[job._rowIndex]" class="dash-go-btn" @click="confirmReassign(job)">Go</button>
                </div>
                <button class="dash-cancel-btn" style="flex-shrink:0;" @click="confirmCancel(job)">✕</button>
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
        <div class="dash-modal-container">
          <div class="dash-modal-header">
            <div class="flex items-center gap-3">
              <h3 style="font-size:1.1rem;font-weight:700;">{{ loadIdValue || 'Load Details' }}</h3>
            </div>
            <button class="dash-modal-close" @click="closeDetail">&times;</button>
          </div>
          <div style="padding:1.25rem;overflow-y:auto;flex:1;">
            <template v-for="section in detailSections" :key="section.title">
              <div v-if="section.fields.length" style="margin-bottom:1rem;">
                <div class="dash-section-title">{{ section.title }}</div>
                <div class="dash-detail-grid">
                  <div v-for="field in section.fields" :key="field.col" :style="[field.wide ? 'grid-column:span 2' : '']" style="display:flex;flex-direction:column;gap:2px;padding:0.75rem;border-bottom:1px solid #f3f4f6;">
                    <span style="font-size:0.68rem;font-weight:600;text-transform:uppercase;color:#9ca3af;">{{ field.col }}</span>
                    <span style="font-size:0.875rem;">{{ field.value || '\u2014' }}</span>
                  </div>
                </div>
              </div>
            </template>
            <div style="margin-bottom:1rem;">
              <div class="dash-section-title">Documents</div>
              <div class="dash-detail-grid" style="display:block;padding:0.75rem;">
                <div v-if="loadingDocs" style="text-align:center;color:#6b7280;font-size:0.875rem;padding:0.75rem;">Loading...</div>
                <div v-else-if="loadDocs.length === 0" style="text-align:center;color:#6b7280;font-size:0.875rem;padding:0.75rem;">No documents</div>
                <div v-else style="display:flex;flex-direction:column;gap:0.5rem;">
                  <div v-for="doc in loadDocs" :key="doc.id" class="flex items-center justify-between" style="padding:0.25rem 0;">
                    <div class="flex items-center gap-2">
                      <span style="font-size:0.75rem;font-weight:600;padding:2px 8px;border-radius:4px;background:#f0f9ff;color:#0284c7;">{{ doc.type }}</span>
                      <span style="font-size:0.875rem;">{{ doc.file_name }}</span>
                    </div>
                    <a v-if="doc.drive_url" :href="doc.drive_url" target="_blank" style="font-size:0.75rem;color:#38bdf8;">View</a>
                  </div>
                </div>
              </div>
            </div>
            <div>
              <div class="dash-section-title">Route Map</div>
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
