<template>
  <Dialog v-model:open="openProxy">
    <DialogContent class="sm:max-w-[820px] rounded-[14px] border-[#e8edf2] shadow-[0_8px_32px_rgba(0,0,0,0.12)] p-0 gap-0 overflow-hidden max-h-[92vh] flex flex-col">
      <DialogHeader class="px-6 pt-5 pb-4 border-b border-[#e8edf2] bg-gradient-to-b from-gray-50/80 to-white">
        <DialogTitle class="text-[1.1rem] font-bold text-gray-900">Payment Report</DialogTitle>
        <DialogDescription class="text-[13px] text-gray-400">
          How much was a payee paid? Pick a payee plus a billing week or a custom date range.
        </DialogDescription>
      </DialogHeader>

      <div class="report-body">
        <!-- Controls -->
        <div class="controls">
          <div class="field">
            <label class="f-label">Payee</label>
            <input v-model="payee" list="report-payee-options" class="f-input" placeholder="Driver or employee name" maxlength="100" />
            <datalist id="report-payee-options">
              <option v-for="p in payees" :key="p" :value="p" />
            </datalist>
          </div>
          <div class="field">
            <label class="f-label">Period</label>
            <select v-model="mode" class="f-input">
              <option value="week">Billing week (Sat–Fri)</option>
              <option value="range">Custom range</option>
            </select>
          </div>
          <div v-if="mode === 'week'" class="field">
            <label class="f-label">Any day in the week</label>
            <input v-model="weekDate" type="date" class="f-input" />
          </div>
          <template v-else>
            <div class="field">
              <label class="f-label">From</label>
              <input v-model="from" type="date" class="f-input" />
            </div>
            <div class="field">
              <label class="f-label">To</label>
              <input v-model="to" type="date" class="f-input" />
            </div>
          </template>
          <div class="field self-end">
            <Button class="bg-blue-600 hover:bg-blue-700 text-white text-[12px] h-9" :disabled="busy || !canRun" @click="run">
              {{ busy ? 'Running…' : 'Run report' }}
            </Button>
          </div>
        </div>
        <div v-if="errorMsg" class="text-[12px] text-red-600 font-semibold">{{ errorMsg }}</div>

        <!-- Results -->
        <template v-if="report">
          <div class="summary-grid">
            <div class="sum-card sum-emerald">
              <div class="sum-label">Total paid</div>
              <div class="sum-value">${{ fmtMoney(report.summary.totalPaid) }}</div>
              <div class="sum-sub">{{ report.summary.paidCount }} invoice(s) marked Paid</div>
            </div>
            <div class="sum-card sum-amber">
              <div class="sum-label">Pending</div>
              <div class="sum-value">${{ fmtMoney(report.summary.totalPending) }}</div>
              <div class="sum-sub">{{ report.summary.pendingCount }} submitted / approved / processing</div>
            </div>
            <div class="sum-card sum-blue">
              <div class="sum-label">Total payable</div>
              <div class="sum-value">${{ fmtMoney(report.summary.totalPayable) }}</div>
              <div class="sum-sub">{{ report.summary.invoiceCount }} invoice(s) in period</div>
            </div>
          </div>

          <div class="text-[12px] text-gray-500">
            <b class="uppercase">{{ report.payee }}</b> — {{ report.from }} to {{ report.to }}
          </div>

          <div v-if="!report.invoices.length" class="text-[13px] text-gray-400 italic py-4 text-center">
            No invoices found for this payee in the selected period.
          </div>
          <table v-else class="report-table">
            <thead>
              <tr>
                <th>Invoice #</th>
                <th>Period</th>
                <th>Status</th>
                <th class="num">Base</th>
                <th class="num">Adjust</th>
                <th class="num">Total due</th>
                <th class="num">Paid on</th>
              </tr>
            </thead>
            <tbody>
              <tr v-for="inv in report.invoices" :key="inv.id">
                <td class="font-mono text-[11px] font-semibold">
                  {{ inv.invoice_number }}
                  <span v-if="inv.is_manual" class="manual-chip">Manual</span>
                </td>
                <td class="whitespace-nowrap">{{ inv.week_start }} – {{ inv.week_end }}</td>
                <td><Badge :class="statusBadge(inv.status)">{{ inv.status }}</Badge></td>
                <td class="num">${{ fmtMoney(inv.total_earnings) }}</td>
                <td class="num" :class="inv.adjustment > 0 ? 'text-emerald-700' : inv.adjustment < 0 ? 'text-red-600' : 'text-gray-400'">
                  {{ inv.adjustment ? (inv.adjustment > 0 ? '+' : '-') + '$' + fmtMoney(Math.abs(inv.adjustment)) : '—' }}
                </td>
                <td class="num font-semibold">${{ fmtMoney(inv.total_due) }}</td>
                <td class="num text-gray-500">{{ inv.status === 'Paid' && inv.paid_at ? String(inv.paid_at).slice(0, 10) : '—' }}</td>
              </tr>
            </tbody>
          </table>
        </template>
      </div>

      <div class="px-6 py-4 border-t border-[#e8edf2] flex justify-between items-center bg-gray-50/50">
        <a v-if="report" :href="pdfHref" target="_blank">
          <Button variant="outline" class="text-[12px] border-[#e2e4ea]">&#8595; Download PDF</Button>
        </a>
        <span v-else></span>
        <Button variant="outline" class="text-[12px]" @click="openProxy = false">Close</Button>
      </div>
    </DialogContent>
  </Dialog>
</template>

<script setup>
import { computed, ref, watch } from 'vue'
import { useInvoicesStore } from '../../stores/invoices'
import { Badge } from '@/components/ui/badge'
import { Button } from '@/components/ui/button'
import { Dialog, DialogContent, DialogDescription, DialogHeader, DialogTitle } from '@/components/ui/dialog'

const props = defineProps({
  open: { type: Boolean, default: false },
  payees: { type: Array, default: () => [] },
})
const emit = defineEmits(['update:open'])

const store = useInvoicesStore()

const openProxy = computed({
  get: () => props.open,
  set: (v) => emit('update:open', v),
})

const payee = ref('')
const mode = ref('week')
const weekDate = ref('')
const from = ref('')
const to = ref('')
const report = ref(null)
const busy = ref(false)
const errorMsg = ref('')

watch(() => props.open, (isOpen) => {
  if (isOpen) {
    report.value = null
    errorMsg.value = ''
  }
})

const canRun = computed(() => {
  if (!payee.value.trim()) return false
  if (mode.value === 'week') return !!weekDate.value
  return !!from.value && !!to.value
})

const reportParams = computed(() => {
  const params = { payee: payee.value.trim() }
  if (mode.value === 'week') params.week = weekDate.value
  else { params.from = from.value; params.to = to.value }
  return params
})

const pdfHref = computed(() => {
  const qs = new URLSearchParams()
  qs.set('payee', reportParams.value.payee)
  if (reportParams.value.week) qs.set('week', reportParams.value.week)
  else { qs.set('from', reportParams.value.from || ''); qs.set('to', reportParams.value.to || '') }
  return `/api/invoices/report/pdf?${qs.toString()}`
})

async function run() {
  if (busy.value || !canRun.value) return
  if (mode.value === 'range' && from.value > to.value) {
    errorMsg.value = '"From" must be on or before "To"'
    return
  }
  busy.value = true
  errorMsg.value = ''
  try {
    report.value = await store.fetchReport(reportParams.value)
  } catch (err) {
    report.value = null
    errorMsg.value = err?.message || 'Failed to run report'
  } finally {
    busy.value = false
  }
}

function fmtMoney(n) {
  return Number(n || 0).toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 })
}
function statusBadge(status) {
  if (status === 'Draft')      return 'bg-gray-50 text-gray-600 border border-gray-200 text-[10px] font-semibold'
  if (status === 'Submitted')  return 'bg-amber-50 text-amber-700 border border-amber-200 text-[10px] font-semibold'
  if (status === 'Approved')   return 'bg-blue-50 text-blue-700 border border-blue-200 text-[10px] font-semibold'
  if (status === 'Processing') return 'bg-orange-50 text-orange-700 border border-orange-200 text-[10px] font-semibold'
  if (status === 'Paid')       return 'bg-emerald-50 text-emerald-700 border border-emerald-200 text-[10px] font-semibold'
  return 'bg-red-50 text-red-700 border border-red-200 text-[10px] font-semibold'
}
</script>

<style scoped>
.report-body {
  padding: 1.25rem 1.5rem;
  display: flex;
  flex-direction: column;
  gap: 1rem;
  overflow-y: auto;
}
.controls {
  display: flex;
  align-items: flex-end;
  gap: 0.75rem;
  flex-wrap: wrap;
}
.controls .field { min-width: 150px; }
.field { display: flex; flex-direction: column; gap: 0.3rem; }
.f-label { font-size: 0.72rem; font-weight: 700; color: #475569; }
.f-input {
  height: 36px;
  padding: 0 0.7rem;
  border: 1px solid #e2e4ea;
  border-radius: 8px;
  background: #fff;
  font-family: inherit;
  font-size: 0.82rem;
  color: #111827;
}
.f-input:focus { outline: none; border-color: #3b82f6; box-shadow: 0 0 0 3px rgba(59,130,246,0.1); }
.summary-grid {
  display: grid;
  grid-template-columns: repeat(3, 1fr);
  gap: 0.75rem;
}
.sum-card {
  border-radius: 10px;
  padding: 0.8rem 1rem;
  border: 1px solid #e8edf2;
}
.sum-emerald { background: #ecfdf5; border-color: #a7f3d0; }
.sum-amber { background: #fffbeb; border-color: #fde68a; }
.sum-blue { background: #eff6ff; border-color: #bfdbfe; }
.sum-label { font-size: 0.68rem; font-weight: 700; text-transform: uppercase; color: #64748b; }
.sum-value { font-size: 1.25rem; font-weight: 800; color: #0f172a; font-variant-numeric: tabular-nums; }
.sum-sub { font-size: 0.7rem; color: #64748b; }
.report-table {
  width: 100%;
  border-collapse: collapse;
  font-size: 0.78rem;
}
.report-table th {
  text-align: left;
  font-size: 0.66rem;
  font-weight: 700;
  text-transform: uppercase;
  letter-spacing: 0.03em;
  color: #64748b;
  padding: 0.45rem 0.6rem;
  background: #f8fafc;
  border-bottom: 1px solid #e8edf2;
}
.report-table td {
  padding: 0.5rem 0.6rem;
  border-bottom: 1px solid #f1f5f9;
  color: #111827;
}
.report-table .num { text-align: right; white-space: nowrap; font-variant-numeric: tabular-nums; }
.manual-chip {
  display: inline-block;
  margin-left: 0.35rem;
  padding: 0.05rem 0.35rem;
  border-radius: 4px;
  background: #f5f3ff;
  color: #6d28d9;
  border: 1px solid #ddd6fe;
  font-size: 0.6rem;
  font-weight: 700;
  text-transform: uppercase;
  font-family: inherit;
}

@media (max-width: 700px) {
  .summary-grid { grid-template-columns: 1fr; }
}
</style>
