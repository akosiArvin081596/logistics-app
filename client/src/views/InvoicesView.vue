<template>
  <div class="flex flex-col">
    <div class="dash-header">
      <div>
        <h2 class="text-[1.4rem] font-bold text-gray-900 tracking-tight">Driver Invoices</h2>
        <p class="text-[13px] text-gray-400 mt-0.5">Review, approve, and mark driver weekly invoices as paid</p>
      </div>
      <div class="flex items-center gap-3">
        <span class="text-[11px] text-gray-400 font-mono bg-gray-50 px-3 py-1.5 rounded-full border border-gray-100">{{ filteredInvoices.length }} {{ activeFilter || 'total' }}</span>
        <Button variant="outline" class="rounded-md border-[#e2e4ea] text-[12px] h-9" @click="exportCsv">Export CSV</Button>
        <Button variant="outline" class="rounded-md border-[#e2e4ea] text-[12px] h-9" @click="store.load()">&#8635; Refresh</Button>
      </div>
    </div>

    <!-- KPI cards -->
    <div class="kpi-grid" style="margin-bottom:1.25rem;">
      <Card v-for="card in kpiCards" :key="card.label" class="kpi-card" :class="[card.theme, { 'kpi-active': activeFilter === card.filter }]" style="cursor:pointer;" @click="handleKpiClick(card.filter)">
        <CardContent class="flex items-center gap-4" style="padding:1rem 1.25rem;">
          <div :class="['kpi-icon', card.iconTheme]" v-html="card.icon"></div>
          <div class="kpi-info">
            <div class="kpi-label">{{ card.label }}</div>
            <div class="kpi-value">{{ card.value }}</div>
            <div class="kpi-sub">{{ card.sub }}</div>
          </div>
        </CardContent>
      </Card>
    </div>

    <!-- Filter bar -->
    <div class="flex items-center gap-3" style="margin-bottom:1rem;">
      <label class="text-[12px] text-gray-500 font-semibold">Driver</label>
      <select v-model="driverFilter" class="filter-select">
        <option value="">All drivers</option>
        <option v-for="d in driverOptions" :key="d" :value="d">{{ d }}</option>
      </select>
      <label class="text-[12px] text-gray-500 font-semibold">Week</label>
      <input v-model="weekFilter" type="date" class="filter-select" />
      <Button v-if="activeFilter || driverFilter || weekFilter" variant="ghost" size="sm" class="text-[12px] h-8" @click="clearFilters">Clear filters</Button>
    </div>

    <!-- Table -->
    <Card class="flex flex-col" style="border-radius:14px;border:1px solid #e8edf2;box-shadow:0 1px 4px rgba(0,0,0,0.06), 0 4px 12px rgba(0,0,0,0.04);">
      <CardContent style="padding:0;">
        <div v-if="store.isLoading" class="flex items-center justify-center py-16">
          <div class="text-[13px] text-gray-400">Loading invoices...</div>
        </div>
        <div v-else-if="filteredInvoices.length === 0" class="flex flex-col items-center justify-center py-16 gap-2">
          <div class="text-[2rem]">&#128178;</div>
          <div class="text-[14px] text-gray-500 font-medium">No invoices yet</div>
          <div class="text-[12px] text-gray-400">Driver weekly invoices will appear here</div>
        </div>
        <Table v-else>
          <TableHeader>
            <TableRow class="bg-gray-50/80 hover:bg-gray-50/80">
              <TableHead class="text-[11px] font-bold text-gray-500 uppercase tracking-wider">Invoice #</TableHead>
              <TableHead class="text-[11px] font-bold text-gray-500 uppercase tracking-wider">Driver</TableHead>
              <TableHead class="text-[11px] font-bold text-gray-500 uppercase tracking-wider">Week</TableHead>
              <TableHead class="text-[11px] font-bold text-gray-500 uppercase tracking-wider text-right">Loads</TableHead>
              <TableHead class="text-[11px] font-bold text-gray-500 uppercase tracking-wider text-right">Total</TableHead>
              <TableHead class="text-[11px] font-bold text-gray-500 uppercase tracking-wider">Status</TableHead>
              <TableHead class="text-[11px] font-bold text-gray-500 uppercase tracking-wider">Submitted</TableHead>
              <TableHead class="text-[11px] font-bold text-gray-500 uppercase tracking-wider text-right">Actions</TableHead>
            </TableRow>
          </TableHeader>
          <TableBody>
            <TableRow v-for="inv in filteredInvoices" :key="inv.id" class="hover:bg-blue-50/30 transition-colors duration-100 cursor-pointer" @click="openDetail(inv)">
              <TableCell class="font-mono text-[12px] font-semibold text-gray-900">{{ inv.invoice_number }}</TableCell>
              <TableCell class="font-semibold text-[13px] text-gray-900 uppercase">{{ inv.driver }}</TableCell>
              <TableCell class="text-[12px] text-gray-600 whitespace-nowrap">{{ formatWeek(inv.week_start, inv.week_end) }}</TableCell>
              <TableCell class="text-[13px] text-gray-600 text-right">{{ inv.loads_count }}</TableCell>
              <TableCell class="text-[13px] font-semibold text-emerald-700 text-right">
                ${{ fmtMoney(inv.total_earnings) }}
                <span v-if="hasAdjustment(inv)" :class="adjBadgeClass(inv)" :title="adjTooltip(inv)">
                  {{ formatAdj(inv.adjustment) }}
                </span>
              </TableCell>
              <TableCell><Badge :class="statusBadge(inv.status)">{{ inv.status }}</Badge></TableCell>
              <TableCell class="text-[12px] text-gray-500 whitespace-nowrap">{{ inv.submitted_at ? formatDate(inv.submitted_at) : '\u2014' }}</TableCell>
              <TableCell class="text-right" @click.stop>
                <div class="flex items-center justify-end gap-1.5">
                  <a :href="`/api/invoices/${inv.id}/pdf`" target="_blank"><Button size="sm" variant="outline" class="rounded-md border-[#e2e4ea] text-[12px] h-8">PDF</Button></a>
                  <Button v-if="inv.status === 'Submitted'" size="sm" class="rounded-md bg-emerald-600 hover:bg-emerald-700 text-white text-[12px] h-8" @click="quickAction(inv, 'approve')">Approve</Button>
                  <Button v-if="inv.status === 'Approved'" size="sm" class="rounded-md bg-blue-600 hover:bg-blue-700 text-white text-[12px] h-8" @click="quickAction(inv, 'paid')">Mark Paid</Button>
                </div>
              </TableCell>
            </TableRow>
          </TableBody>
        </Table>
      </CardContent>
    </Card>

    <!-- Detail Modal -->
    <Dialog v-model:open="showDetail">
      <DialogContent class="sm:max-w-[920px] rounded-[14px] border-[#e8edf2] shadow-[0_8px_32px_rgba(0,0,0,0.12)] p-0 gap-0 overflow-hidden max-h-[92vh]">
        <DialogHeader class="px-6 pt-5 pb-4 border-b border-[#e8edf2] bg-gradient-to-b from-gray-50/80 to-white">
          <DialogTitle class="text-[1.1rem] font-bold text-gray-900">{{ selectedInvoice?.invoice_number }}</DialogTitle>
          <DialogDescription class="text-[13px] text-gray-400">
            <span class="uppercase font-semibold">{{ selectedInvoice?.driver }}</span>
            — {{ selectedInvoice && formatWeek(selectedInvoice.week_start, selectedInvoice.week_end) }}
          </DialogDescription>
        </DialogHeader>
        <div v-if="selectedInvoice" class="detail-body">
          <!-- Left: PDF preview -->
          <div class="detail-pdf">
            <iframe :src="`/api/invoices/${selectedInvoice.id}/pdf`" class="pdf-frame" title="Invoice PDF"></iframe>
          </div>

          <!-- Right: meta + actions -->
          <div class="detail-meta">
            <div class="meta-section">
              <div class="meta-row"><span class="meta-label">Status</span><Badge :class="statusBadge(selectedInvoice.status)">{{ selectedInvoice.status }}</Badge></div>
              <div class="meta-row"><span class="meta-label">Loads</span><span>{{ selectedInvoice.loads_count }}</span></div>
              <div class="meta-row"><span class="meta-label">Rate / load</span><span>${{ fmtMoney(selectedInvoice.rate_per_load) }}</span></div>
              <div class="meta-row"><span class="meta-label">{{ hasAdjustment(selectedInvoice) ? 'Computed' : 'Total earnings' }}</span><span class="font-semibold text-emerald-700">${{ fmtMoney(selectedInvoice.total_earnings) }}</span></div>
              <template v-if="hasAdjustment(selectedInvoice)">
                <div class="meta-row">
                  <span class="meta-label">Admin adjust</span>
                  <span :class="['font-semibold', selectedInvoice.adjustment > 0 ? 'text-emerald-700' : 'text-red-600']">
                    {{ formatAdj(selectedInvoice.adjustment) }}
                  </span>
                </div>
                <div v-if="selectedInvoice.adjustment_note" class="meta-row full">
                  <span class="meta-label">Reason</span>
                  <span class="text-gray-700 italic">{{ selectedInvoice.adjustment_note }}</span>
                </div>
                <div v-if="selectedInvoice.adjusted_by" class="meta-row">
                  <span class="meta-label">Adjusted by</span>
                  <span class="text-gray-600 text-[12px]">{{ selectedInvoice.adjusted_by }}{{ selectedInvoice.adjusted_at ? ' · ' + formatDateTime(selectedInvoice.adjusted_at) : '' }}</span>
                </div>
                <div class="meta-row" style="border-top:1px solid #e8edf2; padding-top:0.4rem; margin-top:0.2rem;">
                  <span class="meta-label font-bold">Total due</span>
                  <span class="font-bold text-emerald-700 text-[15px]">${{ fmtMoney((selectedInvoice.total_earnings || 0) + (selectedInvoice.adjustment || 0)) }}</span>
                </div>
              </template>
              <div v-if="selectedInvoice.expenses_total" class="meta-row"><span class="meta-label">Expenses (ref)</span><span>${{ fmtMoney(selectedInvoice.expenses_total) }}</span></div>
            </div>

            <div class="meta-section">
              <div class="meta-section-title">Timeline</div>
              <div class="meta-row"><span class="meta-label">Generated</span><span>{{ formatDateTime(selectedInvoice.created_at) }}</span></div>
              <div v-if="selectedInvoice.submitted_at" class="meta-row"><span class="meta-label">Submitted</span><span>{{ formatDateTime(selectedInvoice.submitted_at) }}</span></div>
              <div v-if="selectedInvoice.approved_at" class="meta-row"><span class="meta-label">{{ selectedInvoice.status === 'Rejected' ? 'Rejected' : 'Approved' }}</span><span>{{ formatDateTime(selectedInvoice.approved_at) }}</span></div>
              <div v-if="selectedInvoice.approved_by" class="meta-row"><span class="meta-label">By</span><span>{{ selectedInvoice.approved_by }}</span></div>
              <div v-if="selectedInvoice.rejection_note" class="meta-row full"><span class="meta-label">Note</span><span class="text-red-700">{{ selectedInvoice.rejection_note }}</span></div>
            </div>

            <!-- Actions -->
            <div class="meta-actions">
              <!-- Adjust button — Super Admin, available on Draft and Submitted before approval. -->
              <Button
                v-if="canAdjust(selectedInvoice)"
                variant="outline"
                class="w-full border-amber-400 text-amber-700 hover:bg-amber-50 hover:text-amber-800 mb-2"
                @click="openAdjust"
              >
                {{ hasAdjustment(selectedInvoice) ? 'Edit adjustment' : '+ Add adjustment' }}
              </Button>

              <div v-if="selectedInvoice.status === 'Submitted'" class="flex flex-col gap-2">
                <Button class="w-full bg-emerald-600 hover:bg-emerald-700 text-white" @click="doAction('approve')">Approve</Button>
                <Button class="w-full bg-red-600 hover:bg-red-700 text-white" @click="showRejectPrompt = true">Reject</Button>
              </div>
              <div v-else-if="selectedInvoice.status === 'Approved'" class="flex flex-col gap-2">
                <Button class="w-full bg-amber-500 hover:bg-amber-600 text-white" @click="doAction('processing')">Mark as Processing</Button>
                <Button class="w-full bg-blue-600 hover:bg-blue-700 text-white" @click="doAction('paid')">Mark as Paid</Button>
                <p class="text-[11px] text-gray-500 text-center">Use <b>Processing</b> when payment is initiated but not yet confirmed. Use <b>Paid</b> when funds are confirmed.</p>
              </div>
              <div v-else-if="selectedInvoice.status === 'Processing'" class="flex flex-col gap-2">
                <Button class="w-full bg-blue-600 hover:bg-blue-700 text-white" @click="doAction('paid')">Mark as Paid</Button>
                <p class="text-[11px] text-gray-500 text-center">Payment is in flight. Click when the funds clear.</p>
              </div>
              <div v-else-if="selectedInvoice.status === 'Paid'" class="paid-banner">
                <div class="paid-icon">&#10003;</div>
                <div>
                  <div class="paid-title">Paid</div>
                  <div class="paid-sub">Settled on {{ formatDate(selectedInvoice.approved_at) }}</div>
                </div>
              </div>
              <div v-else-if="selectedInvoice.status === 'Rejected'" class="rejected-banner">
                <div>Invoice rejected. Driver can regenerate with corrections.</div>
              </div>
              <div v-else-if="selectedInvoice.status === 'Draft'" class="draft-banner">
                <div>Driver has not submitted yet.</div>
              </div>
            </div>

            <!-- Reject prompt -->
            <div v-if="showRejectPrompt" class="reject-prompt">
              <label class="text-[12px] font-semibold text-gray-700">Rejection reason</label>
              <textarea v-model="rejectionNote" rows="3" class="reject-textarea" placeholder="Explain why this invoice was rejected..."></textarea>
              <div class="flex gap-2">
                <Button variant="outline" class="flex-1 text-[12px]" @click="showRejectPrompt = false; rejectionNote = ''">Cancel</Button>
                <Button class="flex-1 bg-red-600 hover:bg-red-700 text-white text-[12px]" :disabled="!rejectionNote.trim()" @click="doReject">Confirm Reject</Button>
              </div>
            </div>

            <!-- Adjust prompt — inline form for +/- adjustment + reason -->
            <div v-if="showAdjustPrompt" class="adjust-prompt">
              <label class="text-[12px] font-semibold text-gray-700">Admin adjustment (USD)</label>
              <div class="flex gap-2 items-center">
                <span class="text-gray-500 text-[14px]">$</span>
                <input
                  v-model.number="adjustAmount"
                  type="number"
                  step="0.01"
                  min="-10000"
                  max="10000"
                  class="adjust-input flex-1"
                  placeholder="0.00"
                />
              </div>
              <div class="adjust-hint">
                Positive = bonus (e.g. <code>200</code>), negative = deduction (e.g. <code>-50</code>). Cap &plusmn;$10,000.
              </div>
              <label class="text-[12px] font-semibold text-gray-700 mt-2">Reason</label>
              <textarea
                v-model="adjustReason"
                rows="2"
                class="reject-textarea"
                placeholder="e.g. Performance bonus / Advance recoupment / Damage deduction"
              ></textarea>
              <div class="adjust-preview" v-if="selectedInvoice">
                Computed: <strong>${{ fmtMoney(selectedInvoice.total_earnings) }}</strong>
                <span v-if="Number(adjustAmount) !== 0">
                  &nbsp;{{ Number(adjustAmount) > 0 ? '+' : '-' }} <strong>${{ fmtMoney(Math.abs(Number(adjustAmount) || 0)) }}</strong>
                  &nbsp;=&nbsp;
                  <strong class="text-emerald-700">
                    ${{ fmtMoney((selectedInvoice.total_earnings || 0) + (Number(adjustAmount) || 0)) }}
                  </strong>
                </span>
              </div>
              <div class="flex gap-2 mt-2">
                <Button variant="outline" class="flex-1 text-[12px]" :disabled="adjustBusy" @click="cancelAdjust">Cancel</Button>
                <Button
                  v-if="hasAdjustment(selectedInvoice)"
                  variant="outline"
                  class="flex-1 text-[12px] border-red-300 text-red-600 hover:bg-red-50"
                  :disabled="adjustBusy"
                  @click="removeAdjustment"
                >Remove</Button>
                <Button
                  class="flex-1 bg-emerald-600 hover:bg-emerald-700 text-white text-[12px]"
                  :disabled="adjustBusy || !Number.isFinite(Number(adjustAmount))"
                  @click="submitAdjust"
                >{{ adjustBusy ? 'Saving…' : 'Save adjustment' }}</Button>
              </div>
            </div>
          </div>
        </div>
      </DialogContent>
    </Dialog>
  </div>
</template>

<script setup>
import { ref, computed, onMounted } from 'vue'
import { useInvoicesStore } from '../stores/invoices'
import { useAuthStore } from '../stores/auth'
import { useToast } from '../composables/useToast'
import { useSocketRefresh } from '../composables/useSocketRefresh'
import { Card, CardContent } from '@/components/ui/card'
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from '@/components/ui/table'
import { Badge } from '@/components/ui/badge'
import { Button } from '@/components/ui/button'
import { Dialog, DialogContent, DialogDescription, DialogHeader, DialogTitle } from '@/components/ui/dialog'

const store = useInvoicesStore()
const auth = useAuthStore()
const { show: toast } = useToast()
useSocketRefresh('invoices:changed', () => store.load())

const showDetail = ref(false)
const selectedInvoice = ref(null)
const activeFilter = ref(null)
const driverFilter = ref('')
const weekFilter = ref('')
const showRejectPrompt = ref(false)
const rejectionNote = ref('')

// Adjustment prompt state — opens inline below the action buttons.
const showAdjustPrompt = ref(false)
const adjustAmount = ref(0)
const adjustReason = ref('')
const adjustBusy = ref(false)

const driverOptions = computed(() => {
  const names = store.invoices.map(i => (i.driver || '').toUpperCase()).filter(Boolean)
  return [...new Set(names)].sort()
})

const filteredInvoices = computed(() => {
  let list = store.invoices
  if (activeFilter.value) list = list.filter(i => i.status === activeFilter.value)
  if (driverFilter.value) list = list.filter(i => (i.driver || '').toUpperCase() === driverFilter.value)
  if (weekFilter.value) list = list.filter(i => i.week_start <= weekFilter.value && i.week_end >= weekFilter.value)
  return list.slice().sort((a, b) => (b.created_at || '').localeCompare(a.created_at || ''))
})

const kpiCards = computed(() => [
  { label: 'Submitted',  value: store.submittedCount, sub: `$${fmtMoney(store.totalSubmitted)} pending review`, icon: '&#128228;', theme: 'kpi-amber',   iconTheme: 'kpi-icon-amber',   filter: 'Submitted' },
  { label: 'Approved',   value: store.approvedCount,  sub: `$${fmtMoney(store.totalApproved)} ready to pay`,   icon: '&#10003;',  theme: 'kpi-blue',    iconTheme: 'kpi-icon-blue',    filter: 'Approved' },
  { label: 'Processing', value: store.processingCount, sub: `$${fmtMoney(store.totalProcessing)} payment in flight`, icon: '&#8644;', theme: 'kpi-amber',   iconTheme: 'kpi-icon-amber',   filter: 'Processing' },
  { label: 'Paid',       value: store.paidCount,      sub: `$${fmtMoney(store.totalPaid)} settled`,            icon: '&#128176;', theme: 'kpi-emerald', iconTheme: 'kpi-icon-emerald', filter: 'Paid' },
  { label: 'Rejected',   value: store.rejectedCount,  sub: 'Need correction',                                   icon: '&#10007;',  theme: 'kpi-violet',  iconTheme: 'kpi-icon-violet',  filter: 'Rejected' },
])

function handleKpiClick(filter) {
  activeFilter.value = activeFilter.value === filter ? null : filter
}

function clearFilters() {
  activeFilter.value = null
  driverFilter.value = ''
  weekFilter.value = ''
}

function openDetail(inv) {
  selectedInvoice.value = inv
  showDetail.value = true
  showRejectPrompt.value = false
  rejectionNote.value = ''
  showAdjustPrompt.value = false
  adjustAmount.value = 0
  adjustReason.value = ''
}

// --- Adjustment helpers ---
function hasAdjustment(inv) {
  return inv && Number(inv.adjustment || 0) !== 0
}
function canAdjust(inv) {
  return inv && auth.isSuperAdmin && (inv.status === 'Draft' || inv.status === 'Submitted')
}
function formatAdj(amount) {
  const n = Number(amount || 0)
  if (n === 0) return ''
  return (n > 0 ? '+' : '-') + '$' + fmtMoney(Math.abs(n))
}
function adjBadgeClass(inv) {
  const n = Number(inv.adjustment || 0)
  const base = 'ml-1.5 inline-block px-1.5 py-0.5 rounded text-[10px] font-bold align-middle '
  return base + (n > 0 ? 'bg-emerald-100 text-emerald-700' : 'bg-red-100 text-red-700')
}
function adjTooltip(inv) {
  const n = Number(inv.adjustment || 0)
  const note = inv.adjustment_note || '(no reason given)'
  const newTotal = (inv.total_earnings || 0) + n
  return `Admin adjustment: ${formatAdj(n)} (${note})\nNew total: $${fmtMoney(newTotal)}`
}

function openAdjust() {
  if (!selectedInvoice.value) return
  adjustAmount.value = Number(selectedInvoice.value.adjustment || 0)
  adjustReason.value = selectedInvoice.value.adjustment_note || ''
  showAdjustPrompt.value = true
  showRejectPrompt.value = false
}
function cancelAdjust() {
  if (adjustBusy.value) return
  showAdjustPrompt.value = false
  adjustAmount.value = 0
  adjustReason.value = ''
}
async function submitAdjust() {
  if (!selectedInvoice.value || adjustBusy.value) return
  const amt = Number(adjustAmount.value)
  if (!Number.isFinite(amt)) {
    toast('Adjustment must be a number', 'error')
    return
  }
  if (Math.abs(amt) > 10000) {
    toast('Adjustment magnitude capped at $10,000', 'error')
    return
  }
  adjustBusy.value = true
  try {
    const res = await store.adjust(selectedInvoice.value.id, amt, adjustReason.value.trim())
    const fresh = store.invoices.find(i => i.id === selectedInvoice.value.id)
    if (fresh) selectedInvoice.value = fresh
    showAdjustPrompt.value = false
    if (amt === 0) {
      toast('Adjustment removed', 'success')
    } else if (res?.pdfMode === 'addendum') {
      // Legacy invoice (no render snapshot): the PDF got an appended summary page.
      toast(`Adjustment saved (${formatAdj(amt)}) — a summary page was added to the PDF`, 'success')
    } else {
      toast(`Adjustment saved (${formatAdj(amt)})`, 'success')
    }
  } catch (err) {
    toast(err?.message || 'Failed to save adjustment', 'error')
  } finally {
    adjustBusy.value = false
  }
}
async function removeAdjustment() {
  if (!selectedInvoice.value || adjustBusy.value) return
  adjustBusy.value = true
  try {
    await store.adjust(selectedInvoice.value.id, 0, '')
    const fresh = store.invoices.find(i => i.id === selectedInvoice.value.id)
    if (fresh) selectedInvoice.value = fresh
    showAdjustPrompt.value = false
    toast('Adjustment removed', 'success')
  } catch (err) {
    toast(err?.message || 'Failed to remove adjustment', 'error')
  } finally {
    adjustBusy.value = false
  }
}

async function quickAction(inv, action) {
  try {
    await store.updateStatus(inv.id, action)
    toast(`Invoice ${action === 'paid' ? 'marked as paid' : 'approved'}`, 'success')
  } catch (err) {
    toast(err.message || 'Action failed', 'error')
  }
}

async function doAction(action) {
  if (!selectedInvoice.value) return
  try {
    await store.updateStatus(selectedInvoice.value.id, action)
    const fresh = store.invoices.find(i => i.id === selectedInvoice.value.id)
    if (fresh) selectedInvoice.value = fresh
    toast(`Invoice ${action === 'paid' ? 'marked as paid' : 'approved'}`, 'success')
  } catch (err) {
    toast(err.message || 'Action failed', 'error')
  }
}

async function doReject() {
  if (!selectedInvoice.value || !rejectionNote.value.trim()) return
  try {
    await store.updateStatus(selectedInvoice.value.id, 'reject', rejectionNote.value.trim())
    const fresh = store.invoices.find(i => i.id === selectedInvoice.value.id)
    if (fresh) selectedInvoice.value = fresh
    showRejectPrompt.value = false
    rejectionNote.value = ''
    toast('Invoice rejected', 'success')
  } catch (err) {
    toast(err.message || 'Rejection failed', 'error')
  }
}

function exportCsv() {
  const rows = filteredInvoices.value
  if (!rows.length) { toast('Nothing to export', 'warning'); return }
  const header = ['Invoice Number', 'Driver', 'Week Start', 'Week End', 'Loads', 'Rate', 'Total Earnings', 'Expenses', 'Status', 'Submitted At', 'Approved At', 'Approved By', 'Rejection Note']
  const escape = (v) => {
    const s = v == null ? '' : String(v)
    return s.includes(',') || s.includes('"') || s.includes('\n') ? `"${s.replace(/"/g, '""')}"` : s
  }
  const lines = [header.join(',')]
  for (const r of rows) {
    lines.push([
      r.invoice_number, r.driver, r.week_start, r.week_end,
      r.loads_count, r.rate_per_load, r.total_earnings, r.expenses_total,
      r.status, r.submitted_at, r.approved_at, r.approved_by, r.rejection_note,
    ].map(escape).join(','))
  }
  const blob = new Blob([lines.join('\n')], { type: 'text/csv' })
  const url = URL.createObjectURL(blob)
  const a = document.createElement('a')
  a.href = url
  a.download = `invoices-${new Date().toISOString().slice(0, 10)}.csv`
  a.click()
  URL.revokeObjectURL(url)
}

// --- Formatters ---
function fmtMoney(n) {
  const num = Number(n || 0)
  return num.toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 })
}
function formatDate(d) {
  if (!d) return ''
  return new Date(d).toLocaleDateString('en-US', { month: 'short', day: 'numeric', year: 'numeric' })
}
function formatDateTime(d) {
  if (!d) return ''
  return new Date(d).toLocaleString('en-US', { month: 'short', day: 'numeric', year: 'numeric', hour: 'numeric', minute: '2-digit' })
}
function formatWeek(start, end) {
  if (!start || !end) return ''
  const s = new Date(start + 'T12:00:00').toLocaleDateString('en-US', { month: 'short', day: 'numeric' })
  const e = new Date(end + 'T12:00:00').toLocaleDateString('en-US', { month: 'short', day: 'numeric', year: 'numeric' })
  return `${s} – ${e}`
}
function statusBadge(status) {
  if (status === 'Draft')      return 'bg-gray-50 text-gray-600 border border-gray-200 text-[11px] font-semibold'
  if (status === 'Submitted')  return 'bg-amber-50 text-amber-700 border border-amber-200 text-[11px] font-semibold'
  if (status === 'Approved')   return 'bg-blue-50 text-blue-700 border border-blue-200 text-[11px] font-semibold'
  if (status === 'Processing') return 'bg-orange-50 text-orange-700 border border-orange-200 text-[11px] font-semibold'
  if (status === 'Paid')       return 'bg-emerald-50 text-emerald-700 border border-emerald-200 text-[11px] font-semibold'
  return 'bg-red-50 text-red-700 border border-red-200 text-[11px] font-semibold'
}

onMounted(() => store.load())
</script>

<style scoped>
.filter-select {
  height: 36px;
  padding: 0 0.75rem;
  border: 1px solid #e2e4ea;
  border-radius: 8px;
  background: #fff;
  font-size: 0.82rem;
  color: #111827;
  font-family: inherit;
  min-width: 140px;
}
.filter-select:focus { outline: none; border-color: #3b82f6; box-shadow: 0 0 0 3px rgba(59,130,246,0.1); }

.detail-body {
  display: grid;
  grid-template-columns: 1fr 360px;
  gap: 0;
  min-height: 600px;
  max-height: calc(92vh - 80px);
}
.detail-pdf {
  background: #f1f5f9;
  border-right: 1px solid #e8edf2;
  overflow: hidden;
}
.pdf-frame {
  width: 100%;
  height: 100%;
  border: 0;
  min-height: 600px;
}
.detail-meta {
  padding: 1.25rem 1.5rem;
  overflow-y: auto;
  display: flex;
  flex-direction: column;
  gap: 1.25rem;
}
.meta-section {
  display: flex;
  flex-direction: column;
  gap: 0.5rem;
}
.meta-section-title {
  font-size: 0.72rem;
  font-weight: 700;
  color: #94a3b8;
  text-transform: uppercase;
  letter-spacing: 0.04em;
  margin-bottom: 0.25rem;
}
.meta-row {
  display: flex;
  justify-content: space-between;
  align-items: center;
  font-size: 0.82rem;
  padding: 0.35rem 0;
  border-bottom: 1px solid #f1f5f9;
}
.meta-row.full {
  flex-direction: column;
  align-items: flex-start;
  gap: 0.3rem;
}
.meta-row.full span:last-child {
  font-size: 0.78rem;
  line-height: 1.5;
}
.meta-row:last-child { border-bottom: none; }
.meta-label {
  color: #64748b;
  font-weight: 600;
  font-size: 0.75rem;
}
.meta-actions {
  padding-top: 1rem;
  border-top: 1px solid #e8edf2;
}
.paid-banner {
  display: flex;
  align-items: center;
  gap: 0.85rem;
  padding: 1rem;
  background: #ecfdf5;
  border: 1px solid #a7f3d0;
  border-radius: 10px;
}
.paid-icon {
  width: 36px;
  height: 36px;
  border-radius: 50%;
  background: #10b981;
  color: #fff;
  display: flex;
  align-items: center;
  justify-content: center;
  font-size: 1.25rem;
  font-weight: 700;
  flex-shrink: 0;
}
.paid-title { font-size: 0.95rem; font-weight: 700; color: #065f46; }
.paid-sub { font-size: 0.75rem; color: #047857; }
.rejected-banner {
  padding: 0.75rem 1rem;
  background: #fef2f2;
  border: 1px solid #fecaca;
  border-radius: 8px;
  font-size: 0.78rem;
  color: #991b1b;
}
.draft-banner {
  padding: 0.75rem 1rem;
  background: #f8fafc;
  border: 1px solid #e2e8f0;
  border-radius: 8px;
  font-size: 0.78rem;
  color: #64748b;
}
.reject-prompt {
  margin-top: 1rem;
  padding: 1rem;
  background: #fef2f2;
  border: 1px solid #fecaca;
  border-radius: 10px;
  display: flex;
  flex-direction: column;
  gap: 0.6rem;
}
.reject-textarea {
  width: 100%;
  padding: 0.6rem 0.8rem;
  border: 1px solid #fecaca;
  border-radius: 8px;
  background: #fff;
  font-family: inherit;
  font-size: 0.82rem;
  color: #111827;
  resize: vertical;
  min-height: 70px;
}
.reject-textarea:focus { outline: none; border-color: #dc2626; box-shadow: 0 0 0 3px rgba(220,38,38,0.1); }

/* Adjustment prompt — visually distinct from reject (amber tone) */
.adjust-prompt {
  margin-top: 1rem;
  padding: 1rem;
  background: #fffbeb;
  border: 1px solid #fde68a;
  border-radius: 10px;
  display: flex;
  flex-direction: column;
  gap: 0.35rem;
}
.adjust-input {
  padding: 0.5rem 0.7rem;
  border: 1px solid #fde68a;
  border-radius: 8px;
  background: #fff;
  font-family: inherit;
  font-size: 0.95rem;
  font-weight: 600;
  color: #111827;
}
.adjust-input:focus { outline: none; border-color: #d97706; box-shadow: 0 0 0 3px rgba(217,119,6,0.15); }
.adjust-hint { font-size: 0.7rem; color: #92400e; }
.adjust-hint code { background: #fef3c7; padding: 0 0.25rem; border-radius: 3px; }
.adjust-preview {
  margin-top: 0.5rem;
  padding: 0.5rem 0.7rem;
  background: #fff;
  border: 1px dashed #fde68a;
  border-radius: 8px;
  font-size: 0.78rem;
  color: #6b7280;
  text-align: center;
}

@media (max-width: 900px) {
  .detail-body { grid-template-columns: 1fr; }
  .detail-pdf { max-height: 400px; }
}
</style>
