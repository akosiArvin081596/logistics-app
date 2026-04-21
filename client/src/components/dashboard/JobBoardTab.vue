<template>
  <div>
    <div class="dash-search-bar" style="display:flex;align-items:center;justify-content:space-between;gap:1rem;flex-wrap:wrap;">
      <Input v-model="searchQuery" type="text" placeholder="Search load number..." class="max-w-[320px]" />
      <PaginationBar :page="page" :page-size="pageSize" :total="filteredJobs.length" :total-pages="totalPages" @go="goTo" @size="setSize" style="margin:0;padding:0;border:none;" />
    </div>

    <div class="overflow-x-auto">
      <SkeletonLoader v-if="loading" />
      <EmptyState v-else-if="filteredJobs.length === 0">{{ searchQuery ? 'No loads match your search.' : 'All loads are assigned.' }}</EmptyState>
      <!-- Mobile: card-per-load. Tap the card body → detail modal. Assign
           dropdown stays inline so dispatch can handle the most common
           action without opening anything. -->
      <div v-else-if="isMobile" class="mobile-job-list">
        <div v-for="job in paginatedItems" :key="job._rowIndex" class="mobile-job-card" @click="openDetail(job)">
          <div class="mobile-job-head">
            <div class="mobile-job-id">{{ cellValue(job, loadIdCol) || '—' }}</div>
            <StatusBadge :status="statusValueOf(job) || 'Unassigned'" />
          </div>
          <div class="mobile-job-route">
            <div class="mobile-job-row"><span class="mobile-job-label">Pickup</span><span>{{ job._pickupLocation || '—' }}</span></div>
            <div class="mobile-job-row"><span class="mobile-job-label">Drop-off</span><span>{{ job._dropLocation || '—' }}</span></div>
          </div>
          <div v-if="!hideAssign(job)" class="mobile-job-actions" @click.stop>
            <select v-model="assignSelections[job._rowIndex]" class="dash-select mobile-job-select">
              <option value="">Select driver</option>
              <option v-for="d in drivers" :key="d" :value="d">{{ d }}</option>
            </select>
            <Button size="sm" class="mobile-job-btn" @click="assign(job)">Assign</Button>
            <Button v-if="auth.isSuperAdmin" variant="destructive" size="sm" class="mobile-job-btn" title="Cancel load (no driver needed)" @click="confirmCancel(job)">&#10005;</Button>
          </div>
        </div>
      </div>
      <!-- Desktop: existing table unchanged -->
      <Table v-else>
        <TableHeader>
          <TableRow>
            <TableHead v-for="col in displayCols" :key="col">{{ col }}</TableHead>
            <TableHead>Assign Driver</TableHead>
          </TableRow>
        </TableHeader>
        <TableBody>
          <TableRow v-for="job in paginatedItems" :key="job._rowIndex" class="cursor-pointer" @click="openDetail(job)">
            <TableCell v-for="col in displayCols" :key="col">
              <StatusBadge v-if="/status/i.test(col)" :status="job[col] || 'Unassigned'" />
              <template v-else>{{ cellValue(job, col) }}</template>
            </TableCell>
            <TableCell @click.stop>
              <div v-if="!hideAssign(job)" class="flex items-center gap-2">
                <select v-model="assignSelections[job._rowIndex]" class="dash-select" style="min-width:140px">
                  <option value="">Select driver</option>
                  <option v-for="d in drivers" :key="d" :value="d">{{ d }}</option>
                </select>
                <Button size="sm" @click="assign(job)">Assign</Button>
                <Button v-if="auth.isSuperAdmin" variant="destructive" size="sm" title="Cancel load (no driver needed)" @click="confirmCancel(job)">&#10005;</Button>
              </div>
              <span v-else class="text-gray-300">&mdash;</span>
            </TableCell>
          </TableRow>
        </TableBody>
      </Table>
    </div>
    <Dialog :open="!!selectedJob" @update:open="v => { if (!v) selectedJob = null }">
      <DialogContent class="max-w-[700px] max-h-[88vh] flex flex-col overflow-hidden" style="padding:0;">
        <DialogHeader class="border-b border-gray-100 bg-muted/50" style="padding:1.25rem 1.5rem;">
          <div style="display:flex;align-items:center;justify-content:space-between;gap:0.75rem;flex-wrap:wrap;">
            <div class="flex items-center gap-3">
              <DialogTitle>{{ loadIdValue || 'Load Details' }}</DialogTitle>
              <StatusBadge v-if="statusValue" :status="statusValue" />
            </div>
            <div style="display:flex;gap:0.5rem;align-items:center;">
              <button
                v-if="loadIdValue"
                type="button"
                :style="copyBtnStyle"
                title="Share tracking link with the customer"
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
                  <span style="font-size:0.875rem;">
                    <StatusBadge v-if="/status/i.test(field.col) && field.value" :status="field.value" />
                    <template v-else>{{ field.value || '\u2014' }}</template>
                  </span>
                </div>
              </div>
            </div>
          </template>
          <div style="margin-bottom:1rem;">
            <div class="dash-section-title">Route Map</div>
            <DriverRouteMap :load="selectedJob" :headers="mapHeaders" :driver-position="null" dispatch-mode />
          </div>
        </div>
      </DialogContent>
    </Dialog>

    <!-- Soft delete confirm — same pattern as ActiveLoadsTab. -->
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
import { computed, reactive, ref, watch } from 'vue'
import { usePagination } from '../../composables/usePagination'
import { useApi } from '../../composables/useApi'
import { useToast } from '../../composables/useToast'
import { useViewport } from '../../composables/useViewport'
import { Input } from '@/components/ui/input'
import { Button } from '@/components/ui/button'
import { Table, TableHeader, TableBody, TableRow, TableHead, TableCell } from '@/components/ui/table'
import { Dialog, DialogContent, DialogHeader, DialogTitle, DialogDescription } from '@/components/ui/dialog'
import StatusBadge from '../shared/StatusBadge.vue'
import EmptyState from '../shared/EmptyState.vue'
import PaginationBar from '../shared/PaginationBar.vue'
import SkeletonLoader from '../shared/SkeletonLoader.vue'
import DriverRouteMap from '../driver/DriverRouteMap.vue'
import ConfirmModal from '../shared/ConfirmModal.vue'
import { useAuthStore } from '../../stores/auth'
import { useDashboardStore } from '../../stores/dashboard'

const props = defineProps({ jobs: { type: Array, required: true }, drivers: { type: Array, required: true }, headers: { type: Array, required: true }, loading: { type: Boolean, default: false }, active: { type: Boolean, default: true } })
watch(() => props.active, v => { if (!v) selectedJob.value = null })
// Phase: cancel/delete for unassigned loads (2026-04-22 client request). The
// parent DashboardView already has a handleCancel that reuses the same
// endpoint Active Loads uses; we just add the two new emits to opt in.
const emit = defineEmits(['assign', 'cancel', 'deleted'])
const api = useApi()
const { show: toast } = useToast()
const { isMobile } = useViewport()
const auth = useAuthStore()
const dashStore = useDashboardStore()
function statusValueOf(job) { return statusCol.value ? (job[statusCol.value] || '').trim() : '' }
const assignSelections = reactive({})
watch(() => props.jobs, (jobs) => { jobs.forEach(j => { if (!(j._rowIndex in assignSelections)) assignSelections[j._rowIndex] = '' }) }, { immediate: true })
const selectedJob = ref(null)
const searchQuery = ref('')
const loadIdCol = computed(() => props.headers.find(h => /load.?id|job.?id/i.test(h)) || '')
const filteredJobs = computed(() => { const q = searchQuery.value.trim().toLowerCase(); if (!q || !loadIdCol.value) return props.jobs; return props.jobs.filter(j => (j[loadIdCol.value] || '').toString().toLowerCase().includes(q)) })
const statusCol = computed(() => props.headers.find(h => /status/i.test(h)) || null)
function hideAssign(j) { if (statusCol.value && /^(completed|canceled)$/i.test((j[statusCol.value] || '').trim())) return true; return false }
async function openDetail(j) {
  selectedJob.value = { ...j }
  const hasLatCol = props.headers.some(h => /origin.*lat|pickup.*lat|dest.*lat|drop.*lat/i.test(h))
  if (!hasLatCol) {
    const lc = props.headers.find(h => /load.?id|job.?id/i.test(h))
    const lid = lc ? (j[lc] || '').toString().trim() : ''
    if (lid) {
      try {
        const g = await api.get(`/api/geocode/load/${encodeURIComponent(lid)}`)
        if (g.originLat) { selectedJob.value['Origin Lat'] = g.originLat; selectedJob.value['Origin Lng'] = g.originLng }
        if (g.destLat) { selectedJob.value['Dest Lat'] = g.destLat; selectedJob.value['Dest Lng'] = g.destLng }
      } catch { /* silent */ }
    }
  }
}
const mapHeaders = computed(() => {
  const h = [...props.headers]
  if (selectedJob.value && selectedJob.value['Origin Lat'] && !h.some(c => /origin.*lat/i.test(c))) h.push('Origin Lat', 'Origin Lng', 'Dest Lat', 'Dest Lng')
  return h
})
const { page, pageSize, totalPages, paginatedItems, goTo, setSize } = usePagination(filteredJobs)
const brokerSourceCol = computed(() => props.headers.find(h => /broker/i.test(h)) || null)
const phoneSourceCol = computed(() => props.headers.find(h => /phone/i.test(h)) || null)
// Display columns: pick a small set of load-shape columns, then swap any
// matched origin/pickup and destination/drop columns for synthetic
// "Pickup" / "Drop-off" labels that render clean "City, ST ZIP" values
// from the server-side _pickupLocation / _dropLocation enrichment.
// Deshorn asked for this 2026-04-20 — the raw pickup-info / drop-off-info
// sheet columns carry broker references that were confusing.
const ORIGIN_KW_RE = /origin|pickup|shipper/i
const DEST_KW_RE = /dest|drop|receiver|delivery/i
const displayCols = computed(() => {
  const kw = ['load', 'status', 'origin', 'pickup', 'destination', 'drop', 'rate', 'amount']
  const raw = []
  for (const k of kw) {
    const c = props.headers.find(h => new RegExp(k, 'i').test(h) && !raw.includes(h))
    if (c) raw.push(c)
  }
  const base = (raw.length < 3 ? props.headers.slice(0, 8) : raw)
    .filter(c => c !== brokerSourceCol.value && c !== phoneSourceCol.value && !/lat|lng|lon/i.test(c))
  // Swap first origin/pickup col for synthetic "Pickup", first dest/drop col for "Drop-off"
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
  if (!pickupDone) out.splice(Math.min(2, out.length), 0, 'Pickup')
  if (!dropDone) out.splice(Math.min(3, out.length), 0, 'Drop-off')
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
const statusValue = computed(() => { if (!selectedJob.value) return ''; const c = props.headers.find(h => /^status$/i.test(h) || /load.*status/i.test(h)); return c ? selectedJob.value[c] || '' : '' })
const detailSections = computed(() => {
  if (!selectedJob.value) return []; const used = new Set(); const secs = []
  for (const c of props.headers) { if (hiddenCols.test(c)) used.add(c) }
  for (const sp of sectionPatterns) { const f = []; for (const c of props.headers) { if (used.has(c)) continue; if (sp.test.test(c)) { used.add(c); f.push({ col: c, value: detailValue(selectedJob.value, c), wide: sp.wide ? sp.wide.test(c) : false }) } }; secs.push({ title: sp.title, fields: f }) }
  const rem = []; for (const c of props.headers) { if (used.has(c)) continue; rem.push({ col: c, value: detailValue(selectedJob.value, c), wide: false }) }
  if (rem.length) secs.push({ title: 'Other Details', fields: rem }); return secs.filter(s => s.fields.length > 0)
})
function assign(j) { const d = assignSelections[j._rowIndex]; if (!d) { toast('Select a driver first', 'error'); return }; emit('assign', { rowIndex: j._rowIndex, driver: d, job: j }) }

// Cancel / delete for unassigned loads. `cancel` reuses the same endpoint
// Active Loads calls (POST /api/dispatch/cancel) — it clears the driver
// column (no-op for unassigned) and sets status to "Cancelled" so the
// load drops out of every KPI via excludeDroppedLoads() server-side.
// `deleted` soft-deletes via DELETE /api/loads/:loadId.
const showDeleteConfirm = ref(false)
const deleting = ref(false)
const linkCopied = ref(false)
let linkCopiedTimer = null

function confirmCancel(j) {
  if (!confirm(`Cancel load ${cellValue(j, loadIdCol.value) || 'this load'}? It will be removed from every list and KPI.`)) return
  emit('cancel', { rowIndex: j._rowIndex, job: j })
}

async function copyTrackingLink() {
  if (!loadIdValue.value) return
  const url = `${window.location.origin}/track/${encodeURIComponent(loadIdValue.value)}`
  try {
    await navigator.clipboard.writeText(url)
    linkCopied.value = true
    if (linkCopiedTimer) clearTimeout(linkCopiedTimer)
    linkCopiedTimer = setTimeout(() => { linkCopied.value = false }, 1500)
  } catch {
    window.prompt('Copy this tracking link:', url)
  }
}

async function runDelete() {
  if (!loadIdValue.value || deleting.value) return
  deleting.value = true
  try {
    await dashStore.deleteLoad(loadIdValue.value)
    showDeleteConfirm.value = false
    const deletedId = loadIdValue.value
    selectedJob.value = null
    linkCopied.value = false
    if (linkCopiedTimer) { clearTimeout(linkCopiedTimer); linkCopiedTimer = null }
    emit('deleted', { loadId: deletedId })
  } catch {
    // parent can surface a toast via the store; staying silent here keeps this consistent with ActiveLoadsTab
  } finally {
    deleting.value = false
  }
}

// Inline styles for the two header buttons (copy + delete). Consistent with
// ActiveLoadsTab's approach of computed style objects — the file already uses
// inline styling throughout so this keeps the house style.
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
</script>

<style scoped>
.mobile-job-list {
  display: flex;
  flex-direction: column;
  gap: 0.65rem;
  padding: 0.25rem;
}
.mobile-job-card {
  background: #fff;
  border: 1px solid #e2e8f0;
  border-radius: 10px;
  padding: 0.85rem 0.95rem;
  display: flex;
  flex-direction: column;
  gap: 0.5rem;
  cursor: pointer;
  transition: border-color 0.15s;
}
.mobile-job-card:active { border-color: #0f3460; }
.mobile-job-head {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 0.5rem;
}
.mobile-job-id {
  font-family: 'JetBrains Mono', ui-monospace, monospace;
  font-weight: 700;
  font-size: 0.92rem;
  color: #0f172a;
}
.mobile-job-route {
  display: flex;
  flex-direction: column;
  gap: 0.25rem;
  padding-top: 0.25rem;
  border-top: 1px solid #f1f5f9;
}
.mobile-job-row {
  display: flex;
  gap: 0.5rem;
  font-size: 0.82rem;
}
.mobile-job-label {
  width: 70px;
  color: #94a3b8;
  font-weight: 600;
  font-size: 0.7rem;
  text-transform: uppercase;
  letter-spacing: 0.04em;
  flex-shrink: 0;
}
.mobile-job-actions {
  display: flex;
  gap: 0.5rem;
  padding-top: 0.5rem;
  border-top: 1px solid #f1f5f9;
}
.mobile-job-select {
  flex: 1;
  min-width: 0;
}
.mobile-job-btn { flex-shrink: 0; }
</style>
