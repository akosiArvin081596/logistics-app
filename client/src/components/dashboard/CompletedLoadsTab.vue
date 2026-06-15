<template>
  <div>
    <div class="dash-search-bar" style="display:flex;align-items:center;justify-content:space-between;gap:1rem;flex-wrap:wrap;">
      <div style="display:flex;align-items:center;gap:0.5rem;flex-wrap:wrap;">
        <Input v-model="searchQuery" type="text" placeholder="Search load number..." class="max-w-[320px]" />
        <button
          v-if="needsReviewCount > 0"
          type="button"
          :style="reviewToggleStyle"
          :title="needsReviewOnly ? 'Showing only loads that need review' : 'Show only loads where the dispatch workflow couldn’t fully extract the rate-con'"
          @click="needsReviewOnly = !needsReviewOnly"
        >
          <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round" style="margin-right:0.35rem;"><path d="M10.29 3.86 1.82 18a2 2 0 0 0 1.71 3h16.94a2 2 0 0 0 1.71-3L13.71 3.86a2 2 0 0 0-3.42 0z"/><line x1="12" y1="9" x2="12" y2="13"/><line x1="12" y1="17" x2="12.01" y2="17"/></svg>
          Needs Review ({{ needsReviewCount }})
        </button>
      </div>
      <PaginationBar :page="page" :page-size="pageSize" :total="filteredJobs.length" :total-pages="totalPages" @go="goTo" @size="setSize" style="margin:0;padding:0;border:none;" />
    </div>
    <div class="overflow-x-auto">
      <Table v-if="filteredJobs.length > 0">
        <TableHeader>
          <TableRow>
            <TableHead v-for="col in displayCols" :key="col">{{ col }}</TableHead>
          </TableRow>
        </TableHeader>
        <TableBody>
          <TableRow v-for="job in paginatedItems" :key="job._rowIndex" class="cursor-pointer" @click="openDetail(job)">
            <TableCell v-for="col in displayCols" :key="col">
              <StatusBadge v-if="/status/i.test(col) && job[col]" :status="job[col]" />
              <div v-else-if="col === 'Pickup' || col === 'Drop-off'" class="addr-cell">
                <span class="addr-street">{{ addrStreet(job, col) || addrCsz(job, col) || '—' }}</span>
                <span v-if="addrStreet(job, col) && addrCsz(job, col)" class="addr-csz">{{ addrCsz(job, col) }}</span>
              </div>
              <template v-else-if="col === loadIdCol">
                <span v-if="needsReview(job)" :style="reviewBadgeStyle" title="Rate / address missing from the rate-con extract">⚠ Review</span>
                {{ cellValue(job, col) }}
              </template>
              <template v-else>{{ cellValue(job, col) }}</template>
            </TableCell>
          </TableRow>
        </TableBody>
      </Table>
      <EmptyState v-else>{{ needsReviewOnly ? 'No completed loads need review.' : (searchQuery ? 'No loads match your search.' : 'No completed loads.') }}</EmptyState>
    </div>
    <Dialog :open="!!selectedJob" @update:open="v => { if (!v) selectedJob = null }">
      <DialogContent class="max-w-[700px] max-h-[88vh] flex flex-col overflow-hidden" style="padding:0;">
        <DialogHeader class="border-b border-gray-100 bg-muted/50" style="padding:1.25rem 1.5rem;">
          <div style="display:flex;align-items:center;gap:0.5rem;flex-wrap:wrap;">
            <DialogTitle>{{ loadIdValue || 'Load Details' }}</DialogTitle>
            <span v-if="selectedJob && needsReview(selectedJob)" :style="reviewBadgeStyle" title="Rate or address is missing from the rate-con extract. Open in Active Loads → Edit to fill the gaps.">⚠ Needs Review</span>
          </div>
          <DialogDescription class="sr-only">Details for load {{ loadIdValue }}</DialogDescription>
        </DialogHeader>
        <div style="padding:1.25rem;overflow-y:auto;flex:1;">
          <div v-if="selectedJob && (selectedJob._pickupStreet || selectedJob._pickupLocation || selectedJob._dropStreet || selectedJob._dropLocation)" style="margin-bottom:1rem;">
            <div class="dash-section-title">Pickup &amp; Drop-off</div>
            <div class="dash-detail-grid">
              <div style="display:flex;flex-direction:column;gap:2px;padding:0.75rem;border-bottom:1px solid #f3f4f6;">
                <span style="font-size:0.68rem;font-weight:600;text-transform:uppercase;color:#9ca3af;">Pickup</span>
                <span class="addr-street" style="font-size:0.875rem;">{{ selectedJob._pickupStreet || selectedJob._pickupLocation || '—' }}</span>
                <span v-if="selectedJob._pickupStreet && selectedJob._pickupLocation" class="addr-csz" style="font-size:0.8rem;">{{ selectedJob._pickupLocation }}</span>
              </div>
              <div style="display:flex;flex-direction:column;gap:2px;padding:0.75rem;border-bottom:1px solid #f3f4f6;">
                <span style="font-size:0.68rem;font-weight:600;text-transform:uppercase;color:#9ca3af;">Drop-off</span>
                <span class="addr-street" style="font-size:0.875rem;">{{ selectedJob._dropStreet || selectedJob._dropLocation || '—' }}</span>
                <span v-if="selectedJob._dropStreet && selectedJob._dropLocation" class="addr-csz" style="font-size:0.8rem;">{{ selectedJob._dropLocation }}</span>
              </div>
            </div>
          </div>
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
            <div class="dash-section-title">Status Timeline</div>
            <div class="dash-detail-grid" style="display:block;padding:0.75rem;">
              <StatusTimeline v-if="loadIdValue" :load-id="loadIdValue" />
            </div>
          </div>
          <div style="margin-bottom:1rem;">
            <div class="dash-section-title">Documents</div>
            <div class="dash-detail-grid" style="display:block;padding:0.75rem;">
              <div v-if="loadingDocs" style="text-align:center;color:#6b7280;font-size:0.875rem;padding:0.75rem;">Loading...</div>
              <div v-else-if="loadDocs.length === 0" style="text-align:center;color:#6b7280;font-size:0.875rem;padding:0.75rem;">No documents</div>
              <div v-else style="display:flex;flex-direction:column;gap:0.5rem;">
                <div v-for="doc in loadDocs" :key="doc.id" style="display:flex;align-items:center;justify-content:space-between;padding:0.25rem 0;">
                  <div style="display:flex;align-items:center;gap:0.5rem;">
                    <span style="font-size:0.75rem;font-weight:600;padding:2px 8px;border-radius:4px;background:#f0f9ff;color:#0284c7;">{{ doc.type }}</span>
                    <span style="font-size:0.875rem;">{{ doc.file_name }}</span>
                  </div>
                  <a v-if="doc.drive_url" :href="doc.drive_url" target="_blank" style="font-size:0.75rem;color:#38bdf8;">View</a>
                </div>
              </div>
            </div>
          </div>
          <div v-if="auth.isSuperAdmin" style="margin-bottom:1rem;">
            <div class="dash-section-title">Driver Rating</div>
            <div class="dash-detail-grid" style="display:block;padding:0.75rem;">
              <div style="display:flex;align-items:center;gap:0.75rem;">
                <StarRating v-model="loadRating" @update:model-value="submitRating" />
                <span v-if="loadRating" style="font-size:0.8rem;color:#6b7280;">{{ loadRating }}/5</span>
                <span v-else style="font-size:0.8rem;color:#9ca3af;">Not rated</span>
              </div>
            </div>
          </div>
          <div>
            <div class="dash-section-title">Route Map</div>
            <DriverRouteMap :load="selectedJob" :headers="mapHeaders" :driver-position="null" dispatch-mode />
          </div>
        </div>
      </DialogContent>
    </Dialog>
  </div>
</template>

<script setup>
import { computed, ref, watch } from 'vue'
import { usePagination } from '../../composables/usePagination'
import { useApi } from '../../composables/useApi'
import { useAuthStore } from '../../stores/auth'
import { Input } from '@/components/ui/input'
import { Table, TableHeader, TableBody, TableRow, TableHead, TableCell } from '@/components/ui/table'
import { Dialog, DialogContent, DialogHeader, DialogTitle, DialogDescription } from '@/components/ui/dialog'
import StatusBadge from '../shared/StatusBadge.vue'
import StatusTimeline from '../shared/StatusTimeline.vue'
import StarRating from '../shared/StarRating.vue'
import EmptyState from '../shared/EmptyState.vue'
import PaginationBar from '../shared/PaginationBar.vue'
import DriverRouteMap from '../driver/DriverRouteMap.vue'
import { needsReview, countNeedsReview } from '../../lib/loadReview'

const api = useApi()
const auth = useAuthStore()
const props = defineProps({ jobs: { type: Array, required: true }, headers: { type: Array, required: true }, active: { type: Boolean, default: true } })
watch(() => props.active, v => { if (!v) selectedJob.value = null })
const searchQuery = ref('')
const needsReviewOnly = ref(false)
const loadRating = ref(0)
const loadIdCol = computed(() => props.headers.find(h => /load.?id|job.?id/i.test(h)) || '')
const needsReviewCount = computed(() => countNeedsReview(props.jobs))
const filteredJobs = computed(() => {
  let pool = props.jobs
  if (needsReviewOnly.value) pool = pool.filter(needsReview)
  const q = searchQuery.value.trim().toLowerCase()
  if (!q || !loadIdCol.value) return pool
  return pool.filter(j => (j[loadIdCol.value] || '').toString().toLowerCase().includes(q))
})
const reviewToggleStyle = computed(() => ({
  display: 'inline-flex', alignItems: 'center', whiteSpace: 'nowrap',
  padding: '0.4rem 0.75rem', fontSize: '0.75rem', fontWeight: '600',
  borderRadius: '6px', cursor: 'pointer', fontFamily: 'inherit',
  border: '1px solid ' + (needsReviewOnly.value ? '#f59e0b' : '#d1d5db'),
  background: needsReviewOnly.value ? '#fef3c7' : '#ffffff',
  color: needsReviewOnly.value ? '#92400e' : '#374151',
  transition: 'all 0.15s',
}))
const reviewBadgeStyle = {
  display: 'inline-flex', alignItems: 'center', verticalAlign: 'middle',
  marginRight: '0.4rem',
  padding: '1px 6px', fontSize: '0.62rem', fontWeight: '700',
  textTransform: 'uppercase', letterSpacing: '0.04em',
  borderRadius: '4px',
  border: '1px solid #fde68a',
  background: '#fffbeb',
  color: '#92400e',
  whiteSpace: 'nowrap',
}
const { page, pageSize, totalPages, paginatedItems, goTo, setSize } = usePagination(filteredJobs)
const selectedJob = ref(null); const loadDocs = ref([]); const loadingDocs = ref(false)
async function openDetail(job) {
  selectedJob.value = { ...job }; loadDocs.value = []; loadingDocs.value = true; loadRating.value = 0
  const lc = props.headers.find(h => /load.?id|job.?id/i.test(h)); const lid = lc ? (job[lc] || '').trim() : ''
  const p = []
  if (lid) p.push(api.get(`/api/documents/${encodeURIComponent(lid)}`).then(r => { loadDocs.value = r.documents || [] }).catch(() => {}))
  if (lid) p.push(api.get(`/api/load-ratings/${encodeURIComponent(lid)}`).then(r => { loadRating.value = r.rating || 0 }).catch(() => {}))
  const hasLatCol = props.headers.some(h => /origin.*lat|pickup.*lat|dest.*lat|drop.*lat/i.test(h))
  if (!hasLatCol && lid) p.push(api.get(`/api/geocode/load/${encodeURIComponent(lid)}`).then(g => {
    if (g.originLat) { selectedJob.value['Origin Lat'] = g.originLat; selectedJob.value['Origin Lng'] = g.originLng }
    if (g.destLat) { selectedJob.value['Dest Lat'] = g.destLat; selectedJob.value['Dest Lng'] = g.destLng }
  }).catch(() => {}))
  await Promise.all(p); loadingDocs.value = false
}
async function submitRating(r) {
  if (!selectedJob.value) return
  const lc = props.headers.find(h => /load.?id|job.?id/i.test(h)); const lid = lc ? (selectedJob.value[lc] || '').trim() : ''
  const dc = props.headers.find(h => /driver/i.test(h)); const dn = dc ? (selectedJob.value[dc] || '').trim() : ''
  if (!lid || !dn) return
  try { await api.put(`/api/load-ratings/${encodeURIComponent(lid)}`, { rating: r, driverName: dn }); loadRating.value = r } catch {}
}
const mapHeaders = computed(() => {
  const h = [...props.headers]
  if (selectedJob.value && selectedJob.value['Origin Lat'] && !h.some(c => /origin.*lat/i.test(c))) h.push('Origin Lat', 'Origin Lng', 'Dest Lat', 'Dest Lng')
  return h
})
const brokerSourceCol = computed(() => props.headers.find(h => /broker/i.test(h)) || null); const phoneSourceCol = computed(() => props.headers.find(h => /phone/i.test(h)) || null)
// See JobBoardTab/ActiveLoadsTab \u2014 swap the first origin/dest column for the
// synthetic Pickup/Drop-off labels that render the two-line clean address.
const ORIGIN_KW_RE = /origin|pickup|shipper/i
const DEST_KW_RE = /dest|drop|receiver|delivery/i
const displayCols = computed(() => {
  const kw = ['load', 'status', 'driver', 'origin', 'pickup', 'destination', 'drop', 'rate', 'delivery', 'date']
  const m = []
  for (const k of kw) { const c = props.headers.find(h => new RegExp(k, 'i').test(h) && !m.includes(h)); if (c) m.push(c) }
  const base = (m.length < 3 ? props.headers.slice(0, 8) : m)
    .filter(c => c !== brokerSourceCol.value && c !== phoneSourceCol.value && !/lat|lng|lon/i.test(c))
  const out = []
  let pickupDone = false
  let dropDone = false
  for (const col of base) {
    if (!pickupDone && ORIGIN_KW_RE.test(col) && !/lat|lng|lon|date|time|appt|eta/i.test(col)) { out.push('Pickup'); pickupDone = true; continue }
    if (!dropDone && DEST_KW_RE.test(col) && !/lat|lng|lon|date|time|appt|eta/i.test(col)) { out.push('Drop-off'); dropDone = true; continue }
    out.push(col)
  }
  if (!pickupDone) out.splice(Math.min(3, out.length), 0, 'Pickup')
  if (!dropDone) out.splice(Math.min(4, out.length), 0, 'Drop-off')
  return out
})
function parseJsonCell(r) { if (!r || typeof r !== 'string' || r[0] !== '{') return null; try { return JSON.parse(r) } catch { return null } }
function cellValue(j, c) { if (c === 'Pickup') return j._pickupLocation || '\u2014'; if (c === 'Drop-off') return j._dropLocation || '\u2014'; const v = j[c] || ''; const p = parseJsonCell(v); return p ? (p.Name || p.name || Object.values(p).filter(Boolean).join(' \u2022 ')) : v }
function addrStreet(j, c) { return c === 'Pickup' ? j._pickupStreet : j._dropStreet }
function addrCsz(j, c) { return c === 'Pickup' ? j._pickupLocation : j._dropLocation }
function detailValue(j, c) { const v = j[c] || ''; const p = parseJsonCell(v); return p ? Object.entries(p).filter(([,x]) => x).map(([k,x]) => `${k}: ${x}`).join(', ') : v }
const sectionPatterns = [
  { title: 'Load Information', test: /load|job|id|status|driver|truck|trailer|equipment|type|commodity|weight|miles|details/i, wide: /details|commodity/i },
  { title: 'Route', test: /origin|pickup|shipper|dest|drop|receiver|delivery|consignee|city|state|zip|address|location/i, wide: /address/i },
  { title: 'Schedule', test: /date|time|pickup.*date|delivery.*date|appointment|eta|scheduled/i },
  { title: 'Financials', test: /rate|amount|revenue|pay|charge|price|cost|invoice|total/i },
]
// Hide the raw Pickup/Drop-off Address columns from the detail sections — the
// "Pickup & Drop-off" block above already shows them two-line, so repeating the
// single-line raw value in the Route section is redundant.
const hiddenCols = /broker|phone|email|contact|contract|address/i
const loadIdValue = computed(() => { if (!selectedJob.value) return ''; const c = props.headers.find(h => /load.?id|job.?id/i.test(h)); return c ? selectedJob.value[c] || '' : '' })
const detailSections = computed(() => {
  if (!selectedJob.value) return []; const used = new Set(); const secs = []
  for (const c of props.headers) { if (hiddenCols.test(c)) used.add(c) }
  for (const sp of sectionPatterns) { const f = []; for (const c of props.headers) { if (used.has(c)) continue; if (sp.test.test(c)) { used.add(c); f.push({ col: c, value: detailValue(selectedJob.value, c), wide: sp.wide ? sp.wide.test(c) : false }) } }; secs.push({ title: sp.title, fields: f }) }
  const rem = []; for (const c of props.headers) { if (used.has(c)) continue; rem.push({ col: c, value: detailValue(selectedJob.value, c), wide: false }) }
  if (rem.length) secs.push({ title: 'Other Details', fields: rem }); return secs.filter(s => s.fields.length > 0)
})
</script>

<style scoped>
/* Two-line address: street on line 1, "City, ST ZIP" muted on line 2. */
.addr-cell { display: flex; flex-direction: column; min-width: 0; line-height: 1.25; }
.addr-street { font-weight: 500; }
.addr-csz { font-size: 0.92em; color: #64748b; }
</style>
