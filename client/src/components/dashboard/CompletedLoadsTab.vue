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

    <!-- Per-driver history + export — Super Admin only.
         Its own bar rather than more controls in the search row: these answer a
         different question ("what did this driver do, and give me the file")
         than the load-number lookup above, and inlining them made the row wrap
         into a ragged two lines with no clue what the bare dates applied to.
         The driver list is built from the completed loads themselves, never from
         the active-driver roster: work done by a since-deactivated driver is
         exactly the history this answers, and a roster-backed dropdown would
         silently hide it. -->
    <div v-if="auth.isSuperAdmin" class="cl-bar">
      <div v-if="driverCol" class="cl-field">
        <label class="cl-label" for="cl-driver">Driver</label>
        <select id="cl-driver" v-model="driverFilter" class="dash-select cl-control cl-driver">
          <option value="">All drivers</option>
          <option v-for="d in driverOptions" :key="d.key" :value="d.key">{{ d.label }}</option>
        </select>
      </div>

      <!-- Labelled, because two bare mm/dd/yyyy boxes give no clue which date
           they filter on. The basis is the date AS RECORDED on the load — the
           same value the P&L, payouts and invoicing count it on — so a range
           here always agrees with the money. Loads delivered before 2026-08-03
           were stamped in UTC off the VPS, so a late-evening delivery from that
           era is recorded on the following day and filters there too; that is
           the date it was settled on. Loads from 2026-08-03 on are stamped in
           Houston time, so recorded and actual are the same thing. -->
      <div class="cl-field">
        <label class="cl-label" for="cl-from">Delivered <span class="cl-tz">(as recorded)</span></label>
        <div class="cl-dates">
          <input id="cl-from" v-model="fromDate" type="date" class="cl-control cl-date" :max="toDate || undefined" aria-label="Delivered on or after (date as recorded on the load)" />
          <span class="cl-dash" aria-hidden="true">–</span>
          <input v-model="toDate" type="date" class="cl-control cl-date" :min="fromDate || undefined" aria-label="Delivered on or before (date as recorded on the load)" />
        </div>
      </div>

      <button v-if="filtersActive" type="button" class="cl-clear" title="Clear the driver and date filters" @click="clearFilters">Clear</button>

      <!-- Pushed right: this is the action, not another filter. -->
      <div class="cl-actions">
        <span v-if="filtersActive" class="cl-count">{{ filteredJobs.length }} load{{ filteredJobs.length === 1 ? '' : 's' }}</span>
        <button type="button" class="cl-download" :disabled="!canDownload" :title="downloadTitle" @click="downloadExport">
          <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round"><path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4"/><polyline points="7 10 12 15 17 10"/><line x1="12" y1="15" x2="12" y2="3"/></svg>
          Download CSV
        </button>
      </div>
      <!-- The export endpoint only understands driver + date range, so a live
           load-number search or the Needs Review toggle would make the file
           wider than the table. Say so rather than surprise them. -->
      <p v-if="exportWiderThanTable" class="cl-note">Search and Needs Review aren’t applied to the downloaded file.</p>
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
      <EmptyState v-else>{{ emptyMessage }}</EmptyState>
    </div>
    <Dialog :open="!!selectedJob" @update:open="v => { if (!v) selectedJob = null }">
      <DialogContent class="max-w-[700px] max-h-[88vh] flex flex-col overflow-hidden" style="padding:0;">
        <DialogHeader class="border-b border-gray-100 bg-muted/50" style="padding:1.25rem 1.5rem;">
          <div style="display:flex;align-items:center;gap:0.5rem;flex-wrap:wrap;">
            <DialogTitle>{{ loadIdValue || 'Load Details' }}</DialogTitle>
            <span v-if="selectedJob && needsReview(selectedJob)" :style="reviewBadgeStyle" title="Rate or address is missing from the rate-con extract. Open in Active Loads → Edit to fill the gaps.">⚠ Needs Review</span>
            <button type="button" :disabled="drafting" :style="draftBtnStyle" @click="draftInvoice" title="Preview the invoice, POD, and rate-con and verify the recipient, then approve to save a Gmail draft for you to send.">{{ drafting ? 'Preparing…' : '✉ Draft Invoice Email' }}</button>
          </div>
          <div v-if="draftResult" :style="draftMsgStyle">{{ draftResult.msg }}</div>
          <div v-if="approvedDraft" :style="approvedLineStyle">
            <span>✓ Draft #{{ approvedDraft.invoice_id }} → {{ approvedDraft.recipient }} · {{ fmtDraftDate(approvedDraft.created_at) }}</span>
            <button type="button" :style="reviewLinkStyle" :disabled="drafting" @click="draftInvoice">Review</button>
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
              <!-- Persistent, not a toast: the refusal that actually lands here is
                   the 409 "last POD on a delivered load" guard, and its message
                   explains the load would stop being invoiceable. -->
              <div v-if="docError" role="alert" :style="docErrorStyle">{{ docError }}</div>
              <div v-if="loadingDocs" style="text-align:center;color:#6b7280;font-size:0.875rem;padding:0.75rem;">Loading...</div>
              <div v-else-if="loadDocs.length === 0" style="text-align:center;color:#6b7280;font-size:0.875rem;padding:0.75rem;">No documents</div>
              <!-- Filename over a muted upload time, matching ActiveLoadsTab and the
                   driver's DocumentList. On a completed load this is the evidence
                   trail for when the POD backing the invoice actually arrived. -->
              <div v-else style="display:flex;flex-direction:column;gap:0.5rem;">
                <div v-for="doc in loadDocs" :key="doc.id" style="display:flex;align-items:center;justify-content:space-between;padding:0.25rem 0;">
                  <div style="display:flex;align-items:center;gap:0.5rem;min-width:0;flex:1;">
                    <span style="font-size:0.75rem;font-weight:600;padding:2px 8px;border-radius:4px;background:#f0f9ff;color:#0284c7;flex-shrink:0;">{{ doc.type }}</span>
                    <div style="display:flex;flex-direction:column;min-width:0;">
                      <!-- Phone-camera uploads produce long underscore-joined names,
                           which don't word-break and would shove View off the row. -->
                      <span :title="doc.file_name" style="font-size:0.875rem;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;">{{ doc.file_name }}</span>
                      <span style="font-size:0.7rem;color:#94a3b8;">Uploaded {{ fmtUploaded(doc.uploaded_at) }}</span>
                    </div>
                  </div>
                  <!-- Actions in one non-shrinking group so a long
                       underscore-joined filename ellipsizes instead of pushing
                       View/X off the row. -->
                  <div style="display:flex;align-items:center;gap:0.35rem;flex-shrink:0;">
                    <a v-if="doc.drive_url" :href="doc.drive_url" target="_blank" style="font-size:0.75rem;color:#38bdf8;">View</a>
                    <button
                      v-if="canManageDocs"
                      type="button"
                      class="doc-del"
                      :disabled="deletingDocId === doc.id"
                      :aria-label="`Delete ${doc.file_name || doc.type || 'document'}`"
                      :title="`Delete ${doc.file_name || doc.type || 'document'}`"
                      @click="confirmDeleteDoc(doc)"
                    >
                      <span v-if="deletingDocId === doc.id" class="doc-del-spin"></span>
                      <svg v-else width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.4" stroke-linecap="round"><line x1="18" y1="6" x2="6" y2="18"/><line x1="6" y1="6" x2="18" y2="18"/></svg>
                    </button>
                  </div>
                </div>
              </div>
            </div>
            <!-- Admin upload, mirroring ActiveLoadsTab. A missing POD is usually
                 noticed *after* the load lands here (it's what blocks Draft
                 Invoice Email above), so this is the screen where a Super Admin
                 or Dispatcher needs to attach one on the driver's behalf. -->
            <div v-if="loadIdValue && canManageDocs" style="margin-top:0.75rem;">
              <DocumentUpload
                :load-id="loadIdValue"
                :driver-name="selectedJobDriverName"
                :row-index="selectedJob?._rowIndex || 0"
                @uploaded="refreshDocs"
              />
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
    <InvoiceDraftPreviewModal
      v-if="previewData"
      :open="previewOpen"
      :load-id="loadIdValue"
      :preview="previewData"
      :pod-url="podUrl"
      :already-drafted="!!approvedDraft"
      @update:open="v => { previewOpen = v }"
      @approved="onDraftApproved"
    />
  </div>
</template>

<script setup>
import { computed, ref, watch } from 'vue'
import { usePagination } from '../../composables/usePagination'
import { useApi } from '../../composables/useApi'
import { useToast } from '../../composables/useToast'
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
import DocumentUpload from '../driver/DocumentUpload.vue'
import InvoiceDraftPreviewModal from './InvoiceDraftPreviewModal.vue'
import { needsReview, countNeedsReview } from '../../lib/loadReview'
import { fmtSheetMoment, sheetSortKey, fmtTimestamp } from '@/utils/datetime'

const api = useApi()
const { show: toast } = useToast()
const auth = useAuthStore()
const props = defineProps({ jobs: { type: Array, required: true }, headers: { type: Array, required: true }, active: { type: Boolean, default: true } })
watch(() => props.active, v => { if (!v) selectedJob.value = null })
const searchQuery = ref('')
const needsReviewOnly = ref(false)
const loadRating = ref(0)
const loadIdCol = computed(() => props.headers.find(h => /load.?id|job.?id/i.test(h)) || '')
const needsReviewCount = computed(() => countNeedsReview(props.jobs))
// Delivery date/time lives in "Completion Date" (stamped when a load is marked
// delivered through the app; equals the final Status Update Date). Loads
// delivered/imported before this tracking have it blank.
const completionCol = computed(() => props.headers.find(h => /completion|complete/i.test(h)) || props.headers.find(h => /status.*update/i.test(h)) || null)

// --- Driver + delivery-date filters (Super Admin) ---------------------------
const driverFilter = ref('') // normalised driver key, '' = all
const fromDate = ref('')     // 'YYYY-MM-DD' from <input type="date">
const toDate = ref('')
const driverCol = computed(() => props.headers.find(h => /driver/i.test(h)) || '')
// The server's own key rule: trim → lowercase → collapse internal whitespace.
// Without the collapse, sheet drift renders "Rodney Brown" and "Rodney  Brown"
// as two separate drivers, each holding half the history.
const normDriver = (s) => (s || '').toString().trim().toLowerCase().replace(/\s+/g, ' ')
// Distinct drivers present in the completed loads, keyed on the normalised form
// and labelled with the first spelling seen (original casing preserved).
const driverOptions = computed(() => {
  const col = driverCol.value
  if (!col) return []
  const seen = new Map()
  for (const j of props.jobs) {
    const raw = (j[col] || '').toString().trim()
    const key = normDriver(raw)
    if (!key || seen.has(key)) continue
    seen.set(key, raw.replace(/\s+/g, ' '))
  }
  return [...seen.entries()]
    .map(([key, label]) => ({ key, label }))
    .sort((a, b) => a.label.localeCompare(b.label))
})
const driverLabel = computed(() => (driverOptions.value.find(o => o.key === driverFilter.value) || {}).label || '')

// THE DAY BASIS IS AMERICA/CHICAGO — NOT the viewer's timezone. Please don't
// "fix" this back to local time. The company operates out of Houston, so the
// business day IS the Central day; pinning it is what makes the rows on screen,
// the range filter, and the downloaded CSV agree for everyone, wherever they
// open the dashboard. Viewer-local would only line up for people sitting in one
// zone, and the sheet stamp is a UTC wall-clock written by the VPS, so an
// overnight delivery ("7/1/2026 4:16:50" = Jun 30, 11:16 PM CDT) lands on a
// different calendar day depending on who is looking. The server-side export
// buckets on the same Central day.
// Sheet timestamp → 'YYYY-MM-DD' in Central; '' when blank or unparseable.
//
// Delegates to the shared helper because this column now has TWO eras: stamps
// written before 2026-08-04 are a UTC wall clock and must be converted, while
// stamps written after are already a Houston wall clock and must NOT be — a
// second conversion would move an evening delivery back a day and drop it out
// of a range filter that should have matched it.
// Sheet timestamp -> 'YYYY-MM-DD', taken VERBATIM off the front of the cell.
//
// Deliberately NOT timezone-corrected. Every money path (the P&L, the investor
// payout, invoicing) reads this column's date part literally, so converting it
// here made the same load show one day on this screen and count on another in
// the accounting. Load 558865809 was the live example: stored 7/1, displayed
// Jun 30, and its $1,100 counted in JULY — so a June download listed a load
// whose revenue was not in June.
//
// Correcting the accounting instead was rejected: it would move revenue into a
// closed month (client rule — "if it is already closed and locked by the month
// then follow that date"). So the screen defers to the books.
//
// This costs nothing going forward. Since 2026-08-03 the server stamps Houston
// time, so the stored date IS the true business day and literal == correct.
// Only pre-cutover evening loads differ, and for those the recorded date is
// what was settled on.
const centralDay = (v) => {
  const m = String(v || '').trim().match(/^(\d{1,2})\/(\d{1,2})\/(\d{4})/)
  if (m) return `${m[3]}-${m[1].padStart(2, '0')}-${m[2].padStart(2, '0')}`
  const iso = String(v || '').trim().match(/^(\d{4})-(\d{2})-(\d{2})/)
  return iso ? `${iso[1]}-${iso[2]}-${iso[3]}` : ''
}
// Exactly the predicates the export endpoint understands, so the button's
// enabled/disabled state mirrors whether the server would find rows or 404.
const exportMatches = computed(() => {
  let pool = props.jobs
  const dc = driverCol.value
  if (driverFilter.value && dc) pool = pool.filter(j => normDriver(j[dc]) === driverFilter.value)
  const col = completionCol.value
  const from = fromDate.value
  const to = toDate.value
  if (col && (from || to)) {
    pool = pool.filter(j => {
      // 'YYYY-MM-DD' vs 'YYYY-MM-DD', both inclusive. Deliberately a STRING
      // compare against the raw <input type="date"> values — no Date is built
      // from a date-only string on either side, which sidesteps the
      // new Date('2026-07-15')-is-UTC-midnight class of bug outright.
      const day = centralDay(j[col])
      // Blank completion date (pre-tracking / imported load) can't be shown to
      // fall inside the window, so a date filter excludes it rather than guess.
      if (!day) return false
      return (!from || day >= from) && (!to || day <= to)
    })
  }
  return pool
})
const filtersActive = computed(() => !!(driverFilter.value || fromDate.value || toDate.value))
function clearFilters() { driverFilter.value = ''; fromDate.value = ''; toDate.value = '' }
// PaginationBar is fed `filteredJobs.length` while the page slice is computed
// over sortedJobs — so every predicate has to live here, not in sortedJobs, or
// the page count silently desyncs from the rows on screen.
const filteredJobs = computed(() => {
  let pool = exportMatches.value
  if (needsReviewOnly.value) pool = pool.filter(needsReview)
  const q = searchQuery.value.trim().toLowerCase()
  if (!q || !loadIdCol.value) return pool
  return pool.filter(j => (j[loadIdCol.value] || '').toString().toLowerCase().includes(q))
})
const emptyMessage = computed(() => {
  if (needsReviewOnly.value) return 'No completed loads need review.'
  if (searchQuery.value.trim()) return 'No loads match your search.'
  if (filtersActive.value) return 'No completed loads match these filters.'
  return 'No completed loads.'
})
// Order completed loads by delivery date, most recent first; loads with no
// recorded delivery time sort to the bottom.
const sortedJobs = computed(() => {
  const col = completionCol.value
  if (!col) return filteredJobs.value
  // Key on what the Delivery Date column DISPLAYS, not on a resolved instant.
  // The two agree within one era but not across the 2026-08-03 stamp cutover,
  // so sorting by the instant left the table ordered by something no one on
  // screen could read. sheetSortKey is derived the same way fmtSheetMoment
  // renders, so the order always matches the column.
  return [...filteredJobs.value].sort((a, b) => {
    const ka = sheetSortKey(a[col])
    const kb = sheetSortKey(b[col])
    // '' is blank OR unparseable. Pin those last explicitly rather than leaning
    // on '' being the smallest string — that only holds while this sort stays
    // descending, and it is one flipped comparator away from floating every
    // dateless load to the top of the history.
    if (!ka || !kb) return ka === kb ? 0 : (ka ? -1 : 1)
    return kb < ka ? -1 : kb > ka ? 1 : 0
  })
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
// 25/page, not usePagination's default 5 — this tab is the "every load a driver
// did" history, and 5 rows a page turns a year of work into endless paging.
const { page, pageSize, totalPages, paginatedItems, goTo, setSize } = usePagination(sortedJobs, 25)
// Any filter change re-slices the list, so a carried-over page number can land
// on a blank page (filter while on page 4 → nothing). Snap back to page 1.
watch([searchQuery, needsReviewOnly, driverFilter, fromDate, toDate], () => goTo(1))

// --- Export ----------------------------------------------------------------
// "Pattern A": a plain same-origin anchor, deliberately no fetch/blob.
//   • useApi() hard-codes a 20s abort and always res.json()s the body, so it
//     cannot carry a file.
//   • A blob download without an explicit `download` attribute saves as a
//     nameless UUID — the bug that hit the investor exports.
// The button is disabled when nothing matches, which is also the case the
// endpoint answers with a 404 JSON body an anchor couldn't intercept anyway.
const canDownload = computed(() => exportMatches.value.length > 0)
const exportWiderThanTable = computed(() => canDownload.value && (!!searchQuery.value.trim() || needsReviewOnly.value))
const downloadTitle = computed(() => {
  if (!canDownload.value) return 'No completed loads match these filters.'
  const who = driverLabel.value ? `every load ${driverLabel.value} delivered` : 'every completed load'
  let when = ''
  if (fromDate.value && toDate.value) when = ` between ${fromDate.value} and ${toDate.value}`
  else if (fromDate.value) when = ` delivered on or after ${fromDate.value}`
  else if (toDate.value) when = ` delivered on or before ${toDate.value}`
  return `Download ${who}${when} (${exportMatches.value.length} load${exportMatches.value.length === 1 ? '' : 's'}).`
})
const slug = (s) => s.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '')
function exportFileName() {
  const parts = ['completed-loads']
  if (driverLabel.value) parts.push(slug(driverLabel.value))
  if (fromDate.value || toDate.value) parts.push(`${fromDate.value || 'start'}_${toDate.value || 'latest'}`)
  return `${parts.join('-')}.csv`
}
function downloadExport() {
  if (!canDownload.value) return
  const params = new URLSearchParams()
  // Send the human spelling, not the normalised key — the server applies the
  // same trim/lowercase/collapse rule on its side.
  if (driverLabel.value) params.set('driver', driverLabel.value)
  if (fromDate.value) params.set('from', fromDate.value)
  if (toDate.value) params.set('to', toDate.value)
  const qs = params.toString()
  const a = document.createElement('a')
  a.href = `/api/loads/completed/export${qs ? `?${qs}` : ''}`
  a.download = exportFileName()
  document.body.appendChild(a)
  a.click()
  a.remove()
}
// Clear/Download moved to scoped CSS classes (.cl-clear / .cl-download) when the
// filter bar became its own surface — the disabled state is :disabled now, so
// the computed style object it needed is gone with it.
const selectedJob = ref(null); const loadDocs = ref([]); const loadingDocs = ref(false)
// --- Document management (Super Admin + Dispatcher) -------------------------
// Same pair that can upload can delete: a POD gets attached here on the driver's
// behalf, so whoever attached the wrong one has to be able to take it back off.
// Super Admin only, per the owner — POD upload and delete on a completed load
// are both restricted, and the server enforces the same on DELETE. Dispatchers
// keep the upload affordance on ACTIVE loads, which predates this and is where
// they attach a POD that arrived by email mid-haul.
const canManageDocs = computed(() => auth.isSuperAdmin)
const deletingDocId = ref(null)
const docError = ref('')
// 'blocked' = refused on a business rule (the 409 last-POD guard) rather than
// broken; amber reads as "not allowed", red as "something went wrong".
const docErrorKind = ref('error')
const docErrorStyle = computed(() => ({
  marginBottom: '0.6rem',
  padding: '0.5rem 0.7rem',
  borderRadius: '6px',
  fontSize: '0.78rem',
  fontWeight: '600',
  lineHeight: '1.4',
  background: docErrorKind.value === 'blocked' ? '#fffbeb' : '#fef2f2',
  color: docErrorKind.value === 'blocked' ? '#92400e' : '#991b1b',
  border: '1px solid ' + (docErrorKind.value === 'blocked' ? '#fde68a' : '#fecaca'),
}))
// DocumentUpload posts the driver name with the doc so the upload is attributed
// to whoever ran the load, not the admin clicking the button.
const selectedJobDriverName = computed(() => {
  if (!selectedJob.value) return ''
  const c = props.headers.find(h => /driver/i.test(h))
  return c ? (selectedJob.value[c] || '').toString().trim() : ''
})
async function refreshDocs() {
  if (!loadIdValue.value) return
  try {
    const r = await api.get(`/api/documents/${encodeURIComponent(loadIdValue.value)}`)
    loadDocs.value = r.documents || []
  } catch {
    // Keep the existing list on a transient failure — the upload/delete that
    // triggered this already succeeded server-side.
  }
}
// Confirm names the file: these are near-identical machine names
// (7083240_POD_1785763065469.pdf), so "are you sure?" alone doesn't tell you
// which of three PODs is about to go.
async function confirmDeleteDoc(doc) {
  if (!doc || !doc.id || deletingDocId.value) return
  const label = doc.file_name || `this ${doc.type || 'document'}`
  const kind = (doc.type || 'document').toUpperCase() === 'POD' ? 'POD' : (doc.type || 'document')
  const ok = window.confirm(
    `Delete ${label}?\n\n` +
    `It will be removed from load ${loadIdValue.value || 'this load'}. ` +
    `If this is the ${kind} backing the invoice, someone has to re-upload it before the load can be billed.`
  )
  if (!ok) return
  deletingDocId.value = doc.id
  docError.value = ''
  try {
    await api.del(`/api/documents/${encodeURIComponent(doc.id)}`)
    await refreshDocs()
    toast(`${doc.type || 'Document'} deleted`)
  } catch (err) {
    // The server owns the "would this load stop being invoiceable?" rule and
    // returns 409 with a human explanation. Surface its words verbatim —
    // flattening that to "Delete failed" hides the only useful part.
    // useApi only falls back to "Request failed (NNN)" when the response wasn't
    // JSON (e.g. the route isn't deployed yet); name the file in that case so
    // a bare status code isn't the whole message.
    const serverSaid = err && err.data && err.data.error
    docErrorKind.value = err && err.status === 409 ? 'blocked' : 'error'
    docError.value = serverSaid
      ? String(err.data.error)
      : `Couldn't delete ${label} — ${(err && err.message) || 'please try again.'}`
  } finally {
    deletingDocId.value = null
  }
}
async function openDetail(job) {
  selectedJob.value = { ...job }; loadDocs.value = []; loadingDocs.value = true; loadRating.value = 0; draftResult.value = null
  docError.value = ''; deletingDocId.value = null
  previewOpen.value = false; previewData.value = null; approvedDraft.value = null
  const lc = props.headers.find(h => /load.?id|job.?id/i.test(h)); const lid = lc ? (job[lc] || '').trim() : ''
  const p = []
  if (lid) p.push(api.get(`/api/documents/${encodeURIComponent(lid)}`).then(r => { loadDocs.value = r.documents || [] }).catch(() => {}))
  if (lid) p.push(api.get(`/api/load-ratings/${encodeURIComponent(lid)}`).then(r => { loadRating.value = r.rating || 0 }).catch(() => {}))
  if (lid) p.push(api.get(`/api/loads/${encodeURIComponent(lid)}/invoice-draft`).then(r => { approvedDraft.value = r.draft || null }).catch(() => {}))
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
  const kw = ['load', 'status', 'driver', 'origin', 'pickup', 'destination', 'drop', 'rate']
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
  out.push('Delivery Date') // actual delivery date/time as the last column (replaces the old Assigned Date)
  return out
})
function parseJsonCell(r) { if (!r || typeof r !== 'string' || r[0] !== '{') return null; try { return JSON.parse(r) } catch { return null } }
// Delivery date/time. The stored value is a bare wall clock, so fmtSheetMoment
// prints it WITHOUT conversion — the same basis as centralDay() above, so the
// date in this column can never disagree with the date the row filters,
// exports, and gets paid on.
//
// It used to resolve the stamp to a true instant and re-render it in Central.
// That was more "correct" in isolation and wrong in context: it silently
// disagreed with the accounting for pre-cutover evening loads. One column that
// matches the books beats two columns that argue.
//
// A bare stamp gets no zone label either, because the stored value only carries
// one for loads written after 2026-08-03 (Houston) — asserting "CDT" over a
// legacy UTC stamp would be a confident lie. fmtSheetMoment labels only a value
// that actually carries a zone, so that stays true without a special case here.
const fmtDeliveryDate = (v) => fmtSheetMoment(v)
// Document upload time. GET /api/documents/:loadId serves uploaded_at as ISO with
// 'Z', so this is a true instant. Never swap in a raw SQLite stamp: those are UTC
// with no zone marker and the browser reads them as local, landing hours early.
const fmtUploaded = (t) => fmtTimestamp(t)
function cellValue(j, c) { if (c === 'Pickup') return j._pickupLocation || '\u2014'; if (c === 'Drop-off') return j._dropLocation || '\u2014'; if (c === 'Delivery Date') return fmtDeliveryDate(completionCol.value ? j[completionCol.value] : ''); const v = j[c] || ''; const p = parseJsonCell(v); return p ? (p.Name || p.name || Object.values(p).filter(Boolean).join(' \u2022 ')) : v }
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

// --- Draft Invoice Email (every broker) ------------------------------------
// One-click: the backend pulls the rate-con from Drive, generates the invoice,
// attaches the POD, validates the trailer, and saves a Gmail draft. The button
// shows on every completed load — the broker (and therefore the recipient and
// the "Invoice To" block) is resolved server-side, which stays the authority
// on whether a given load can actually be invoiced.
const drafting = ref(false)
const draftResult = ref(null) // { ok: boolean, msg: string } | null
// Review-before-draft: the button now runs a dryRun preview and opens a review
// modal; the real Gmail draft is only created on "Approve & Create Draft".
const previewOpen = ref(false)
const previewData = ref(null) // dryRun response, or null
const approvedDraft = ref(null) // GET /invoice-draft row, or null
// POD row's drive_url (same-origin /uploads path or a Drive link) for the preview.
const podUrl = computed(() => {
  const pod = loadDocs.value.find(d => (d.type || '').toUpperCase() === 'POD')
  return pod && pod.drive_url ? pod.drive_url : null
})
// When the Gmail draft for this load's invoice was created. Houston rule:
// America/Chicago with a visible zone label, never the viewer's zone — the
// carrier runs on Houston time and the owner/developer share one login.
//
// Locale pinned to 'en-US' alongside the zone: with the default locale an
// en-GB/fil-PH browser renders timeZoneName as "GMT-5" rather than "CDT", and
// the label only does its job if it reads as Houston time at a glance.
//
// NOTE: scoped strictly to this draft timestamp. `centralDay` / `fmtDeliveryDate`
// in this file handle sheet-sourced wall-clock dates, which are a different
// problem — do not fold them into this pattern.
function fmtDraftDate(ts) {
  if (!ts) return ''
  const d = new Date(ts) // created_at is ISO ...Z (see load_invoice_drafts)
  if (isNaN(d.getTime())) return String(ts)
  return new Intl.DateTimeFormat('en-US', {
    month: 'numeric', day: 'numeric', year: 'numeric',
    hour: 'numeric', minute: '2-digit', hour12: true,
    timeZone: 'America/Chicago', timeZoneName: 'short',
  }).format(d)
}
const approvedLineStyle = {
  marginTop: '0.5rem', display: 'flex', alignItems: 'center', gap: '0.5rem', flexWrap: 'wrap',
  fontSize: '0.75rem', fontWeight: '600', color: '#166534',
  background: '#f0fdf4', border: '1px solid #bbf7d0', borderRadius: '6px',
  padding: '0.35rem 0.6rem',
}
const reviewLinkStyle = computed(() => ({
  background: 'transparent', border: 'none', padding: '0',
  color: '#0f2847', fontWeight: '700', fontFamily: 'inherit', fontSize: '0.75rem',
  textDecoration: 'underline', cursor: drafting.value ? 'not-allowed' : 'pointer',
  opacity: drafting.value ? 0.6 : 1,
}))
const draftBtnStyle = computed(() => ({
  marginLeft: 'auto', display: 'inline-flex', alignItems: 'center', gap: '0.35rem',
  padding: '0.4rem 0.8rem', fontSize: '0.78rem', fontWeight: '700', borderRadius: '6px',
  border: '1px solid #0f2847', background: drafting.value ? '#64748b' : '#0f2847', color: '#fff',
  fontFamily: 'inherit', whiteSpace: 'nowrap', cursor: drafting.value ? 'not-allowed' : 'pointer',
  opacity: drafting.value ? 0.85 : 1, transition: 'all 0.15s',
}))
const draftMsgStyle = computed(() => ({
  marginTop: '0.5rem', fontSize: '0.78rem', fontWeight: '600',
  padding: '0.4rem 0.6rem', borderRadius: '6px',
  background: draftResult.value && draftResult.value.ok ? '#f0fdf4' : '#fef2f2',
  color: draftResult.value && draftResult.value.ok ? '#166534' : '#991b1b',
  border: '1px solid ' + (draftResult.value && draftResult.value.ok ? '#bbf7d0' : '#fecaca'),
}))
// Runs a dryRun (no draft, no invoice number burned) and opens the review modal.
// Doubles as the "Review" re-open for an already-approved draft.
async function draftInvoice() {
  if (!loadIdValue.value || drafting.value) return
  drafting.value = true; draftResult.value = null
  try {
    // The preview does the same heavy work as approve (Sheets + Drive + Gemini +
    // Puppeteer), so give it the same 60s budget as the approve POST.
    const r = await api.post(`/api/loads/${encodeURIComponent(loadIdValue.value)}/draft-invoice?dryRun=1`, {}, { timeout: 60000 })
    previewData.value = r
    previewOpen.value = true
  } catch (e) {
    draftResult.value = { ok: false, msg: (e && e.message) || 'Failed to prepare the invoice preview.' }
  } finally {
    drafting.value = false
  }
}
// The review modal created the real Gmail draft: surface the success banner,
// close the preview, and refresh the persistent approved-draft line.
async function onDraftApproved(payload) {
  previewOpen.value = false
  draftResult.value = {
    ok: true,
    msg: `✓ Draft ready in Gmail (invoice ${payload.invoiceId}). Verify the details, then send.`,
  }
  const lid = loadIdValue.value
  if (!lid) return
  try {
    const r = await api.get(`/api/loads/${encodeURIComponent(lid)}/invoice-draft`)
    approvedDraft.value = r.draft || null
  } catch { /* keep the success banner even if the refresh fails */ }
}
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
/* Per-document delete. Muted until hover so it never competes with View, but a
   28px hit box so it stays tappable in the same dialog on a phone. */
.doc-del {
  display: inline-flex;
  align-items: center;
  justify-content: center;
  width: 28px;
  height: 28px;
  flex-shrink: 0;
  padding: 0;
  border: none;
  background: transparent;
  border-radius: 6px;
  color: #cbd5e1;
  cursor: pointer;
  font-family: inherit;
  line-height: 1;
  transition: color 0.15s, background 0.15s;
}
.doc-del:hover:not(:disabled) { color: #dc2626; background: #fef2f2; }
.doc-del:focus-visible { outline: 2px solid #dc2626; outline-offset: 1px; }
.doc-del:disabled { cursor: progress; color: #94a3b8; }
.doc-del-spin {
  width: 13px;
  height: 13px;
  border: 2px solid #e2e8f0;
  border-top-color: #94a3b8;
  border-radius: 50%;
  animation: doc-del-spin 0.7s linear infinite;
}
@keyframes doc-del-spin { to { transform: rotate(360deg); } }

/* Driver / date filter controls. The search bar already wraps (flex-wrap on the
   parent), so these only need to stay tappable and go full-width once it does. */
/* Driver-history bar. Its own surface so it reads as one cluster of related
   controls rather than four more chips crowding the search row. */
.cl-bar {
  display: flex; align-items: flex-end; flex-wrap: wrap;
  gap: 0.75rem;
  padding: 0.75rem 0.9rem;
  margin-bottom: 0.75rem;
  background: #f8fafc;
  border: 1px solid #eef2f7;
  border-radius: 10px;
}
.cl-field { display: flex; flex-direction: column; gap: 0.3rem; }
.cl-label {
  font-size: 0.68rem; font-weight: 700; letter-spacing: 0.04em;
  text-transform: uppercase; color: #64748b; white-space: nowrap;
}
.cl-tz { font-weight: 500; text-transform: none; letter-spacing: 0; color: #94a3b8; }

/* One height for every control on the row, so nothing sits half a pixel proud. */
.cl-control {
  height: 2.25rem;
  font-size: 0.8125rem; font-family: inherit;
  background: #fff; border: 1px solid #e2e8f0;
  border-radius: 8px; color: #374151; outline: none;
  transition: border-color 0.15s, box-shadow 0.15s;
}
.cl-control:focus { border-color: #38bdf8; box-shadow: 0 0 0 3px rgba(56,189,248,0.1); }
.cl-driver { max-width: 200px; }
.cl-dates { display: flex; align-items: center; gap: 0.35rem; }
.cl-date { width: 140px; padding: 0 0.55rem; }
.cl-dash { color: #94a3b8; font-size: 0.8125rem; }

.cl-clear {
  height: 2.25rem; padding: 0 0.75rem;
  font-size: 0.75rem; font-weight: 600; font-family: inherit;
  color: #64748b; background: #fff;
  border: 1px solid #e2e8f0; border-radius: 8px;
  cursor: pointer; white-space: nowrap; transition: all 0.15s;
}
.cl-clear:hover { color: #0f172a; border-color: #cbd5e1; }

/* margin-left:auto is what separates action from filters — the download is the
   outcome of the row, not another input on it. */
.cl-actions { display: flex; align-items: center; gap: 0.6rem; margin-left: auto; }
.cl-count { font-size: 0.75rem; color: #64748b; white-space: nowrap; }
.cl-download {
  display: inline-flex; align-items: center; gap: 0.4rem;
  height: 2.25rem; padding: 0 0.9rem;
  font-size: 0.75rem; font-weight: 700; font-family: inherit;
  border-radius: 8px; white-space: nowrap;
  border: 1px solid #0f2847; background: #0f2847; color: #fff;
  cursor: pointer; transition: all 0.15s;
}
.cl-download:hover:not(:disabled) { background: #1b3a63; border-color: #1b3a63; }
.cl-download:disabled { background: #f1f5f9; border-color: #e2e8f0; color: #94a3b8; cursor: not-allowed; }
.cl-note { flex: 1 1 100%; margin: 0; font-size: 0.7rem; color: #94a3b8; line-height: 1.3; }

@media (max-width: 640px) {
  .cl-bar { gap: 0.6rem; }
  .cl-field { flex: 1 1 100%; }
  .cl-driver, .cl-dates { width: 100%; max-width: none; }
  .cl-date { flex: 1 1 0; width: auto; min-width: 0; }
  /* Full-width action on a phone; auto-margin would strand it mid-row. */
  .cl-actions { flex: 1 1 100%; margin-left: 0; justify-content: space-between; }
  .cl-download { flex: 1 1 auto; justify-content: center; }
}
</style>
