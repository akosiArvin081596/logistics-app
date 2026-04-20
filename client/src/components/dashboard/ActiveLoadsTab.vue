<template>
  <div>
    <div class="dash-search-bar" style="display:flex;align-items:center;justify-content:space-between;gap:1rem;flex-wrap:wrap;">
      <Input v-model="searchQuery" type="text" placeholder="Search load number..." class="max-w-[320px]" />
      <PaginationBar :page="page" :page-size="pageSize" :total="filteredJobs.length" :total-pages="totalPages" @go="goTo" @size="setSize" style="margin:0;padding:0;border:none;" />
    </div>

    <div class="overflow-x-auto">
      <EmptyState v-if="filteredJobs.length === 0">{{ searchQuery ? 'No loads match your search.' : 'No active loads right now.' }}</EmptyState>
      <!-- Mobile: card per active load. Tap the card body → detail modal
           (which carries the full status history, Cancel, Delete, and map).
           Inline Status + Driver selects stay because they're the two
           actions a dispatcher does dozens of times a day from the list. -->
      <div v-else-if="isMobile" class="mobile-load-list">
        <div v-for="job in paginatedItems" :key="job._rowIndex" class="mobile-load-card" @click="openDetail(job)">
          <div class="mobile-load-head">
            <div class="mobile-load-id">{{ cellValue(job, loadIdCol) || '—' }}</div>
            <StatusBadge v-if="getCurrentStatus(job)" :status="getCurrentStatus(job)" />
          </div>
          <div class="mobile-load-route">
            <div class="mobile-load-row"><span class="mobile-load-label">Pickup</span><span>{{ job._pickupLocation || '—' }}</span></div>
            <div class="mobile-load-row"><span class="mobile-load-label">Drop-off</span><span>{{ job._dropLocation || '—' }}</span></div>
            <div class="mobile-load-row"><span class="mobile-load-label">Driver</span><span>{{ getCurrentDriver(job) || '—' }}</span></div>
          </div>
          <div class="mobile-load-actions" @click.stop>
            <div class="mobile-load-action">
              <span class="mobile-load-action-label">Status</span>
              <div class="mobile-load-action-row">
                <select v-model="statusSelections[job._rowIndex]" class="dash-select dash-select-sm mobile-load-select">
                  <option value="">Pick status</option>
                  <option v-for="s in statusOptions" :key="s" :value="s">{{ s }}</option>
                </select>
                <Button v-if="statusSelections[job._rowIndex]" size="sm" @click="confirmStatusUpdate(job)">Go</Button>
              </div>
            </div>
            <div class="mobile-load-action">
              <span class="mobile-load-action-label">Driver</span>
              <div class="mobile-load-action-row">
                <select v-model="reassignSelections[job._rowIndex]" class="dash-select dash-select-sm mobile-load-select">
                  <option value="">Pick driver</option>
                  <option v-for="d in drivers" :key="d" :value="d">{{ d }}</option>
                </select>
                <Button v-if="reassignSelections[job._rowIndex]" size="sm" @click="confirmReassign(job)">Go</Button>
              </div>
            </div>
          </div>
        </div>
      </div>
      <!-- Desktop: existing table unchanged -->
      <Table v-else>
        <TableHeader>
          <TableRow>
            <TableHead v-for="col in displayCols" :key="col">{{ col }}</TableHead>
            <TableHead style="min-width:300px;">Actions</TableHead>
          </TableRow>
        </TableHeader>
        <TableBody>
          <TableRow v-for="job in paginatedItems" :key="job._rowIndex" class="cursor-pointer" @click="openDetail(job)">
            <TableCell v-for="col in displayCols" :key="col">
              <StatusBadge v-if="/status/i.test(col) && job[col]" :status="job[col]" />
              <template v-else>{{ cellValue(job, col) }}</template>
            </TableCell>
            <TableCell @click.stop>
              <div style="display:flex;align-items:center;gap:0.5rem;flex-wrap:nowrap;width:100%;">
                <div style="display:flex;flex-direction:column;gap:2px;flex:1;min-width:0;">
                  <span style="font-size:0.6rem;font-weight:700;text-transform:uppercase;letter-spacing:0.06em;color:#9ca3af;padding-left:2px;">Status</span>
                  <div style="display:flex;align-items:center;gap:0.25rem;">
                    <select v-model="statusSelections[job._rowIndex]" class="dash-select dash-select-sm" style="flex:1;min-width:0;">
                      <option value="">{{ getCurrentStatus(job) || 'Pick status' }}</option>
                      <option v-for="s in statusOptions" :key="s" :value="s">{{ s }}</option>
                    </select>
                    <Button v-if="statusSelections[job._rowIndex]" size="sm" @click="confirmStatusUpdate(job)">Go</Button>
                  </div>
                </div>
                <div style="display:flex;flex-direction:column;gap:2px;flex:1;min-width:0;">
                  <span style="font-size:0.6rem;font-weight:700;text-transform:uppercase;letter-spacing:0.06em;color:#9ca3af;padding-left:2px;">Driver</span>
                  <div style="display:flex;align-items:center;gap:0.25rem;">
                    <select v-model="reassignSelections[job._rowIndex]" class="dash-select dash-select-sm" style="flex:1;min-width:0;">
                      <option value="">{{ getCurrentDriver(job) || 'Pick driver' }}</option>
                      <option v-for="d in drivers" :key="d" :value="d">{{ d }}</option>
                    </select>
                    <Button v-if="reassignSelections[job._rowIndex]" size="sm" @click="confirmReassign(job)">Go</Button>
                  </div>
                </div>
                <Button v-if="auth.isSuperAdmin" variant="destructive" size="sm" style="flex-shrink:0;margin-top:14px;" title="Cancel assignment" @click="confirmCancel(job)">&#10005;</Button>
              </div>
            </TableCell>
          </TableRow>
        </TableBody>
      </Table>
    </div>
    <Dialog :open="!!selectedJob" @update:open="v => { if (!v) closeDetail() }">
      <DialogContent class="max-w-[700px] max-h-[88vh] flex flex-col overflow-hidden" style="padding:0;">
        <DialogHeader class="border-b border-gray-100 bg-muted/50" style="padding:1.25rem 1.5rem;">
          <div style="display:flex;align-items:center;justify-content:space-between;gap:0.75rem;">
            <DialogTitle>{{ loadIdValue || 'Load Details' }}</DialogTitle>
            <div style="display:flex;gap:0.5rem;align-items:center;">
              <button
                v-if="loadIdValue"
                type="button"
                :style="copyBtnStyle"
                :title="'Share tracking link with the customer'"
                @click="copyTrackingLink"
              >
                <svg v-if="!linkCopied" width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" style="margin-right:0.35rem;"><rect x="9" y="9" width="13" height="13" rx="2" ry="2"/><path d="M5 15H4a2 2 0 0 1-2-2V4a2 2 0 0 1 2-2h9a2 2 0 0 1 2 2v1"/></svg>
                <svg v-else width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round" style="margin-right:0.35rem;"><path d="M20 6 9 17l-5-5"/></svg>
                {{ linkCopied ? 'Link copied' : 'Copy tracking link' }}
              </button>
              <button
                v-if="loadIdValue && auth.isSuperAdmin"
                type="button"
                :style="deleteBtnStyle"
                :disabled="deleting"
                title="Remove this load from every list and KPI (soft delete, recoverable)"
                @click="showDeleteConfirm = true"
              >
                <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" style="margin-right:0.35rem;"><polyline points="3 6 5 6 21 6"/><path d="M19 6l-1 14a2 2 0 0 1-2 2H8a2 2 0 0 1-2-2L5 6"/><path d="M10 11v6"/><path d="M14 11v6"/></svg>
                {{ deleting ? 'Deleting...' : 'Delete' }}
              </button>
            </div>
          </div>
          <DialogDescription class="sr-only">Details for load {{ loadIdValue }}</DialogDescription>
        </DialogHeader>
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
          <div v-if="auth.isSuperAdmin && isSelectedLoadCompleted" style="margin-bottom:1rem;">
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
            <DriverRouteMap :load="selectedJob" :headers="mapHeaders" :driver-position="selectedDriverPosition" dispatch-mode />
          </div>
        </div>
      </DialogContent>
    </Dialog>

    <!-- Delete confirm — soft delete, reversible in SQL but not from the UI -->
    <ConfirmModal
      :open="showDeleteConfirm"
      title="Delete this load?"
      :message="`Removes ${loadIdValue || 'this load'} from every list and KPI (revenue, financials, investor dashboards). The sheet row stays for external audit; a Super Admin can restore the load via SQL if needed.`"
      confirm-text="Delete"
      :danger="true"
      @confirm="runDelete"
      @cancel="showDeleteConfirm = false"
    />
  </div>
</template>

<script setup>
import { computed, ref, reactive, watch } from 'vue'
import { usePagination } from '../../composables/usePagination'
import { useApi } from '../../composables/useApi'
import { Input } from '@/components/ui/input'
import { Button } from '@/components/ui/button'
import { Table, TableHeader, TableBody, TableRow, TableHead, TableCell } from '@/components/ui/table'
import { Dialog, DialogContent, DialogHeader, DialogTitle, DialogDescription } from '@/components/ui/dialog'
import StatusBadge from '../shared/StatusBadge.vue'
import StarRating from '../shared/StarRating.vue'
import EmptyState from '../shared/EmptyState.vue'
import PaginationBar from '../shared/PaginationBar.vue'
import DriverRouteMap from '../driver/DriverRouteMap.vue'

import { useAuthStore } from '../../stores/auth'
import { useDashboardStore } from '../../stores/dashboard'
import { useViewport } from '../../composables/useViewport'
import ConfirmModal from '../shared/ConfirmModal.vue'
const api = useApi()
const auth = useAuthStore()
const dashStore = useDashboardStore()
const { isMobile } = useViewport()
const props = defineProps({ jobs: { type: Array, required: true }, headers: { type: Array, required: true }, drivers: { type: Array, default: () => [] }, active: { type: Boolean, default: true }, focusLoadId: { type: String, default: '' } })
watch(() => props.active, v => { if (!v) { selectedJob.value = null; selectedDriverPosition.value = null } })
const emit = defineEmits(['reassign', 'cancel', 'status-update', 'deleted', 'focus-consumed'])
const searchQuery = ref('')
const loadIdCol = computed(() => props.headers.find(h => /load.?id|job.?id/i.test(h)) || '')
const filteredJobs = computed(() => { const q = searchQuery.value.trim().toLowerCase(); if (!q || !loadIdCol.value) return props.jobs; return props.jobs.filter(j => (j[loadIdCol.value] || '').toString().toLowerCase().includes(q)) })
const { page, pageSize, totalPages, paginatedItems, goTo, setSize } = usePagination(filteredJobs)
const statusOptions = ['At Shipper', 'Loading', 'In Transit', 'At Receiver', 'Unloading', 'Delivered']
const selectedJob = ref(null); const selectedDriverPosition = ref(null); const reassignSelections = reactive({}); const statusSelections = reactive({}); const loadDocs = ref([]); const loadingDocs = ref(false); const loadRating = ref(0); const linkCopied = ref(false)
const showDeleteConfirm = ref(false)
const deleting = ref(false)
let linkCopiedTimer = null
const copyBtnStyle = computed(() => ({
  display: 'inline-flex', alignItems: 'center', whiteSpace: 'nowrap',
  padding: '0.4rem 0.75rem', fontSize: '0.75rem', fontWeight: '600',
  borderRadius: '6px', cursor: 'pointer', fontFamily: 'inherit',
  border: '1px solid ' + (linkCopied.value ? '#16a34a' : '#d1d5db'),
  background: linkCopied.value ? '#dcfce7' : '#ffffff',
  color: linkCopied.value ? '#166534' : '#374151',
  transition: 'all 0.15s',
}))
const deleteBtnStyle = computed(() => ({
  display: 'inline-flex', alignItems: 'center', whiteSpace: 'nowrap',
  padding: '0.4rem 0.75rem', fontSize: '0.75rem', fontWeight: '600',
  borderRadius: '6px', cursor: deleting.value ? 'not-allowed' : 'pointer', fontFamily: 'inherit',
  border: '1px solid #fecaca',
  background: '#fef2f2',
  color: '#b91c1c',
  opacity: deleting.value ? 0.6 : 1,
  transition: 'all 0.15s',
}))
async function copyTrackingLink() {
  if (!loadIdValue.value) return
  const url = `${window.location.origin}/track/${encodeURIComponent(loadIdValue.value)}`
  try {
    await navigator.clipboard.writeText(url)
    linkCopied.value = true
    if (linkCopiedTimer) clearTimeout(linkCopiedTimer)
    linkCopiedTimer = setTimeout(() => { linkCopied.value = false }, 1500)
  } catch {
    // Clipboard API blocked (non-HTTPS, permission, etc.) — fall back to prompt
    window.prompt('Copy this tracking link:', url)
  }
}
const isSelectedLoadCompleted = computed(() => {
  if (!selectedJob.value) return false
  const sc = props.headers.find(h => /status/i.test(h))
  return sc && /^(delivered|completed|pod received)$/i.test((selectedJob.value[sc] || '').trim())
})
watch(() => props.jobs, (jobs) => { jobs.forEach(j => { if (!(j._rowIndex in statusSelections)) statusSelections[j._rowIndex] = ''; if (!(j._rowIndex in reassignSelections)) reassignSelections[j._rowIndex] = '' }) }, { immediate: true })
const mapHeaders = computed(() => {
  const h = [...props.headers]
  if (selectedJob.value && selectedJob.value['Origin Lat'] && !h.some(c => /origin.*lat/i.test(c))) {
    h.push('Origin Lat', 'Origin Lng', 'Dest Lat', 'Dest Lng')
  }
  return h
})
const statusCol = computed(() => props.headers.find(h => /status/i.test(h)) || ''); const driverCol = computed(() => props.headers.find(h => /driver/i.test(h)) || '')
function getCurrentStatus(j) { return statusCol.value ? (j[statusCol.value] || '') : '' }
function getCurrentDriver(j) { return driverCol.value ? (j[driverCol.value] || '') : '' }
function confirmReassign(j) { const d = reassignSelections[j._rowIndex]; if (!d) return; if (confirm(`Reassign to ${d}?`)) { emit('reassign', { rowIndex: j._rowIndex, newDriver: d, job: j }); reassignSelections[j._rowIndex] = '' } }
function confirmCancel(j) { if (confirm('Cancel this assignment?')) emit('cancel', { rowIndex: j._rowIndex, job: j }) }
function confirmStatusUpdate(j) { const s = statusSelections[j._rowIndex]; if (!s) return; if (confirm(`Update to "${s}"?`)) { emit('status-update', { rowIndex: j._rowIndex, newStatus: s, job: j }); statusSelections[j._rowIndex] = '' } }
function closeDetail() { selectedJob.value = null; selectedDriverPosition.value = null; linkCopied.value = false; if (linkCopiedTimer) { clearTimeout(linkCopiedTimer); linkCopiedTimer = null }; showDeleteConfirm.value = false }

async function runDelete() {
  if (!loadIdValue.value || deleting.value) return
  deleting.value = true
  try {
    await dashStore.deleteLoad(loadIdValue.value)
    showDeleteConfirm.value = false
    const deletedId = loadIdValue.value
    closeDetail()
    emit('deleted', { loadId: deletedId })
  } catch {
    // swallow — parent shows toast via watcher if needed
  } finally {
    deleting.value = false
  }
}

// When the parent passes focusLoadId (e.g. /dashboard?load=LD-123 from a
// notification click), auto-open that load's detail modal. Matches by Load
// ID case-insensitively. Emits focus-consumed so the parent can clear the
// query param and avoid re-triggering on refresh.
watch([() => props.focusLoadId, () => props.jobs], ([focus, jobs]) => {
  if (!focus || !jobs || jobs.length === 0) return
  if (selectedJob.value) {
    const cur = loadIdValue.value
    if (cur && cur.toString().trim().toLowerCase() === focus.trim().toLowerCase()) return
  }
  const lc = props.headers.find(h => /load.?id|job.?id/i.test(h))
  if (!lc) return
  const match = jobs.find(j => (j[lc] || '').toString().trim().toLowerCase() === focus.trim().toLowerCase())
  if (match) {
    openDetail(match)
    emit('focus-consumed')
  }
}, { immediate: true })
async function openDetail(job) {
  selectedJob.value = { ...job }; selectedDriverPosition.value = null; loadDocs.value = []; loadingDocs.value = true; loadRating.value = 0
  const dc = props.headers.find(h => /driver/i.test(h)); const dn = dc ? (job[dc] || '').trim() : ''
  const lc = props.headers.find(h => /load.?id|job.?id/i.test(h)); const lid = lc ? (job[lc] || '').trim() : ''
  const p = []
  if (dn) p.push(api.get('/api/locations/latest').then(d => { const l = (d.locations||[]).find(x => x.driver.toLowerCase() === dn.toLowerCase() && x.latitude); if (l) selectedDriverPosition.value = { latitude: l.latitude, longitude: l.longitude } }).catch(() => {}))
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
const brokerSourceCol = computed(() => props.headers.find(h => /broker/i.test(h)) || null); const phoneSourceCol = computed(() => props.headers.find(h => /phone/i.test(h)) || null)
// See JobBoardTab for the rationale — Pickup/Drop-off columns now render
// server-enriched "City, ST ZIP" strings instead of broker-reference blobs.
const ORIGIN_KW_RE = /origin|pickup|shipper/i
const DEST_KW_RE = /dest|drop|receiver|delivery/i
const displayCols = computed(() => {
  const kw = ['load', 'status', 'driver', 'origin', 'pickup', 'destination', 'drop', 'rate', 'delivery']
  const raw = []
  for (const k of kw) {
    const c = props.headers.find(h => new RegExp(k, 'i').test(h) && !raw.includes(h))
    if (c) raw.push(c)
  }
  const base = (raw.length < 3 ? props.headers.slice(0, 8) : raw)
    .filter(c => c !== brokerSourceCol.value && c !== phoneSourceCol.value && !/lat|lng|lon/i.test(c))
  const out = []
  let pickupDone = false
  let dropDone = false
  for (const col of base) {
    if (!pickupDone && ORIGIN_KW_RE.test(col) && !/lat|lng|lon|date|time|appt|eta/i.test(col)) {
      out.push('Pickup')
      pickupDone = true
      continue
    }
    if (!dropDone && DEST_KW_RE.test(col) && !/lat|lng|lon|date|time|appt|eta/i.test(col)) {
      out.push('Drop-off')
      dropDone = true
      continue
    }
    out.push(col)
  }
  if (!pickupDone) out.splice(Math.min(3, out.length), 0, 'Pickup')
  if (!dropDone) out.splice(Math.min(4, out.length), 0, 'Drop-off')
  return out
})
function parseJsonCell(r) { if (!r || typeof r !== 'string' || r[0] !== '{') return null; try { return JSON.parse(r) } catch { return null } }
function cellValue(j, c) {
  if (c === 'Pickup') return j._pickupLocation || '\u2014'
  if (c === 'Drop-off') return j._dropLocation || '\u2014'
  const v = j[c] || ''
  const p = parseJsonCell(v)
  return p ? (p.Name || p.name || Object.values(p).filter(Boolean).join(' \u2022 ')) : v
}
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

<style scoped>
.mobile-load-list {
  display: flex;
  flex-direction: column;
  gap: 0.65rem;
  padding: 0.25rem;
}
.mobile-load-card {
  background: #fff;
  border: 1px solid #e2e8f0;
  border-radius: 10px;
  padding: 0.85rem 0.95rem;
  display: flex;
  flex-direction: column;
  gap: 0.55rem;
  cursor: pointer;
  transition: border-color 0.15s;
}
.mobile-load-card:active { border-color: #0f3460; }
.mobile-load-head {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 0.5rem;
}
.mobile-load-id {
  font-family: 'JetBrains Mono', ui-monospace, monospace;
  font-weight: 700;
  font-size: 0.92rem;
  color: #0f172a;
}
.mobile-load-route {
  display: flex;
  flex-direction: column;
  gap: 0.25rem;
  padding-top: 0.35rem;
  border-top: 1px solid #f1f5f9;
}
.mobile-load-row {
  display: flex;
  gap: 0.5rem;
  font-size: 0.82rem;
}
.mobile-load-label {
  width: 70px;
  color: #94a3b8;
  font-weight: 600;
  font-size: 0.7rem;
  text-transform: uppercase;
  letter-spacing: 0.04em;
  flex-shrink: 0;
}
.mobile-load-actions {
  display: flex;
  gap: 0.5rem;
  padding-top: 0.55rem;
  border-top: 1px solid #f1f5f9;
}
.mobile-load-action { flex: 1; min-width: 0; display: flex; flex-direction: column; gap: 0.25rem; }
.mobile-load-action-label {
  font-size: 0.6rem;
  font-weight: 700;
  text-transform: uppercase;
  letter-spacing: 0.06em;
  color: #94a3b8;
}
.mobile-load-action-row {
  display: flex;
  gap: 0.25rem;
  align-items: center;
}
.mobile-load-select { flex: 1; min-width: 0; }
</style>
