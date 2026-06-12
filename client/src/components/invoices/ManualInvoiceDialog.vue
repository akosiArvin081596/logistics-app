<template>
  <Dialog v-model:open="openProxy">
    <DialogContent class="sm:max-w-[780px] rounded-[14px] border-[#e8edf2] shadow-[0_8px_32px_rgba(0,0,0,0.12)] p-0 gap-0 overflow-hidden max-h-[92vh] flex flex-col">
      <DialogHeader class="px-6 pt-5 pb-4 border-b border-[#e8edf2] bg-gradient-to-b from-gray-50/80 to-white">
        <DialogTitle class="text-[1.1rem] font-bold text-gray-900">New Manual Invoice</DialogTitle>
        <DialogDescription class="text-[13px] text-gray-400">
          Create an invoice from scratch for any payee (drivers or other employees). Uses the standard invoice PDF format and flows through the normal submit / approve / paid pipeline.
        </DialogDescription>
      </DialogHeader>

      <div class="form-body">
        <!-- Payee -->
        <div class="grid grid-cols-2 gap-3">
          <div class="field">
            <label class="f-label">Payee name <span class="text-red-500">*</span></label>
            <input v-model="form.payee" list="manual-payee-options" class="f-input" placeholder="e.g. Sean Adams" maxlength="100" />
            <datalist id="manual-payee-options">
              <option v-for="p in payees" :key="p" :value="p" />
            </datalist>
          </div>
          <div class="field">
            <label class="f-label">Role / title</label>
            <input v-model="form.payeeRole" class="f-input" placeholder="e.g. Office Admin, Mechanic" maxlength="100" />
          </div>
        </div>
        <div class="grid grid-cols-2 gap-3">
          <div class="field">
            <label class="f-label">Address</label>
            <input v-model="form.payeeAddress" class="f-input" placeholder="Optional" maxlength="200" />
          </div>
          <div class="field">
            <label class="f-label">Phone</label>
            <input v-model="form.payeePhone" class="f-input" placeholder="Optional" maxlength="40" />
          </div>
        </div>

        <!-- Period -->
        <div class="grid grid-cols-2 gap-3">
          <div class="field">
            <label class="f-label">Period start <span class="text-red-500">*</span></label>
            <input v-model="form.periodStart" type="date" class="f-input" />
          </div>
          <div class="field">
            <label class="f-label">Period end <span class="text-red-500">*</span></label>
            <input v-model="form.periodEnd" type="date" class="f-input" />
          </div>
        </div>

        <!-- Line items -->
        <div class="rows-section">
          <div class="rows-header">
            <span class="f-label">Line items <span class="text-red-500">*</span></span>
            <Button variant="outline" size="sm" class="text-[12px] h-7" @click="addRow('lineItems')">+ Add item</Button>
          </div>
          <div v-for="(item, i) in form.lineItems" :key="`li-${i}`" class="item-row">
            <input v-model="item.date" type="date" class="f-input w-[140px]" title="Date (optional)" />
            <input v-model="item.description" class="f-input flex-1" placeholder="Description (e.g. Weekly office support)" maxlength="200" />
            <div class="amount-wrap">
              <span class="text-gray-400 text-[13px]">$</span>
              <input v-model.number="item.amount" type="number" step="0.01" min="0" class="f-input w-[110px] text-right" placeholder="0.00" />
            </div>
            <button class="row-remove" title="Remove row" :disabled="form.lineItems.length === 1" @click="removeRow('lineItems', i)">&#10005;</button>
          </div>
        </div>

        <!-- Deductions -->
        <div class="rows-section">
          <div class="rows-header">
            <span class="f-label">Deductions</span>
            <Button variant="outline" size="sm" class="text-[12px] h-7" @click="addRow('deductions')">+ Add deduction</Button>
          </div>
          <div v-if="!form.deductions.length" class="text-[12px] text-gray-400 italic px-1">No deductions</div>
          <div v-for="(item, i) in form.deductions" :key="`de-${i}`" class="item-row">
            <input v-model="item.date" type="date" class="f-input w-[140px]" title="Date (optional)" />
            <input v-model="item.description" class="f-input flex-1" placeholder="Description (e.g. Advance recoupment)" maxlength="200" />
            <div class="amount-wrap">
              <span class="text-gray-400 text-[13px]">$</span>
              <input v-model.number="item.amount" type="number" step="0.01" min="0" class="f-input w-[110px] text-right" placeholder="0.00" />
            </div>
            <button class="row-remove" title="Remove row" @click="removeRow('deductions', i)">&#10005;</button>
          </div>
        </div>

        <!-- Notes -->
        <div class="field">
          <label class="f-label">Notes</label>
          <textarea v-model="form.notes" rows="2" class="f-input" style="resize:vertical;" placeholder="Optional note shown on the PDF" maxlength="500"></textarea>
        </div>

        <!-- Totals -->
        <div class="totals-strip">
          <div><span class="t-label">Subtotal</span><span class="t-value">${{ fmtMoney(subtotal) }}</span></div>
          <div><span class="t-label">Deductions</span><span class="t-value text-red-600">-${{ fmtMoney(deductionsTotal) }}</span></div>
          <div class="t-total"><span class="t-label">Total due</span><span class="t-value text-emerald-700 font-bold">${{ fmtMoney(totalDue) }}</span></div>
        </div>

        <div v-if="errorMsg" class="text-[12px] text-red-600 font-semibold">{{ errorMsg }}</div>
      </div>

      <div class="px-6 py-4 border-t border-[#e8edf2] flex justify-end gap-2 bg-gray-50/50">
        <Button variant="outline" class="text-[12px]" :disabled="busy" @click="openProxy = false">Cancel</Button>
        <Button class="bg-emerald-600 hover:bg-emerald-700 text-white text-[12px]" :disabled="busy" @click="create">
          {{ busy ? 'Creating…' : 'Create invoice' }}
        </Button>
      </div>
    </DialogContent>
  </Dialog>
</template>

<script setup>
import { computed, ref, watch } from 'vue'
import { useInvoicesStore } from '../../stores/invoices'
import { useToast } from '../../composables/useToast'
import { Button } from '@/components/ui/button'
import { Dialog, DialogContent, DialogDescription, DialogHeader, DialogTitle } from '@/components/ui/dialog'

const props = defineProps({
  open: { type: Boolean, default: false },
  payees: { type: Array, default: () => [] },
})
const emit = defineEmits(['update:open', 'created'])

const store = useInvoicesStore()
const { show: toast } = useToast()

const openProxy = computed({
  get: () => props.open,
  set: (v) => emit('update:open', v),
})

const emptyForm = () => ({
  payee: '',
  payeeRole: '',
  payeeAddress: '',
  payeePhone: '',
  periodStart: '',
  periodEnd: '',
  lineItems: [{ date: '', description: '', amount: null }],
  deductions: [],
  notes: '',
})

const form = ref(emptyForm())
const busy = ref(false)
const errorMsg = ref('')

watch(() => props.open, (isOpen) => {
  if (isOpen) {
    form.value = emptyForm()
    errorMsg.value = ''
  }
})

const sum = (rows) => rows.reduce((s, r) => s + (Number(r.amount) || 0), 0)
const subtotal = computed(() => sum(form.value.lineItems))
const deductionsTotal = computed(() => sum(form.value.deductions))
const totalDue = computed(() => subtotal.value - deductionsTotal.value)

function addRow(kind) {
  form.value[kind] = [...form.value[kind], { date: '', description: '', amount: null }]
}
function removeRow(kind, index) {
  if (kind === 'lineItems' && form.value.lineItems.length === 1) return
  form.value[kind] = form.value[kind].filter((_, i) => i !== index)
}

function validate() {
  const f = form.value
  if (!f.payee.trim()) return 'Payee name is required'
  if (!f.periodStart || !f.periodEnd) return 'Period start and end are required'
  if (f.periodEnd < f.periodStart) return 'Period end must be on or after period start'
  if (!f.lineItems.length) return 'At least one line item is required'
  for (const rows of [f.lineItems, f.deductions]) {
    for (const r of rows) {
      if (!String(r.description || '').trim()) return 'Every row needs a description'
      const amt = Number(r.amount)
      if (!Number.isFinite(amt) || amt < 0) return 'Every row needs an amount of $0 or more'
      if (amt > 1000000) return 'Amounts are capped at $1,000,000 per row'
    }
  }
  return ''
}

async function create() {
  if (busy.value) return
  errorMsg.value = validate()
  if (errorMsg.value) return
  busy.value = true
  try {
    const f = form.value
    const mapRows = (rows) => rows.map(r => ({
      date: r.date || '',
      description: String(r.description || '').trim(),
      amount: Number(r.amount) || 0,
    }))
    const res = await store.createManual({
      payee: f.payee.trim(),
      payeeRole: f.payeeRole.trim(),
      payeeAddress: f.payeeAddress.trim(),
      payeePhone: f.payeePhone.trim(),
      periodStart: f.periodStart,
      periodEnd: f.periodEnd,
      lineItems: mapRows(f.lineItems),
      deductions: mapRows(f.deductions),
      notes: f.notes.trim(),
    })
    toast(`Invoice ${res?.invoice?.invoice_number || ''} created`, 'success')
    openProxy.value = false
    emit('created', res?.invoice || null)
  } catch (err) {
    errorMsg.value = err?.message || 'Failed to create invoice'
  } finally {
    busy.value = false
  }
}

function fmtMoney(n) {
  return Number(n || 0).toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 })
}
</script>

<style scoped>
.form-body {
  padding: 1.25rem 1.5rem;
  display: flex;
  flex-direction: column;
  gap: 0.9rem;
  overflow-y: auto;
}
.field { display: flex; flex-direction: column; gap: 0.3rem; }
.f-label { font-size: 0.75rem; font-weight: 700; color: #475569; }
.f-input {
  padding: 0.5rem 0.7rem;
  border: 1px solid #e2e4ea;
  border-radius: 8px;
  background: #fff;
  font-family: inherit;
  font-size: 0.82rem;
  color: #111827;
}
.f-input:focus { outline: none; border-color: #3b82f6; box-shadow: 0 0 0 3px rgba(59,130,246,0.1); }
.rows-section {
  border: 1px solid #e8edf2;
  border-radius: 10px;
  padding: 0.75rem;
  display: flex;
  flex-direction: column;
  gap: 0.5rem;
  background: #fafbfc;
}
.rows-header { display: flex; justify-content: space-between; align-items: center; }
.item-row { display: flex; align-items: center; gap: 0.5rem; }
.amount-wrap { display: flex; align-items: center; gap: 0.25rem; }
.row-remove {
  width: 26px;
  height: 26px;
  border: 1px solid #fecaca;
  border-radius: 6px;
  background: #fff;
  color: #dc2626;
  font-size: 0.7rem;
  cursor: pointer;
  flex-shrink: 0;
}
.row-remove:disabled { opacity: 0.35; cursor: not-allowed; }
.row-remove:not(:disabled):hover { background: #fef2f2; }
.totals-strip {
  display: flex;
  justify-content: flex-end;
  gap: 1.5rem;
  padding: 0.7rem 1rem;
  background: #f8fafc;
  border: 1px solid #e8edf2;
  border-radius: 10px;
  font-size: 0.82rem;
}
.totals-strip > div { display: flex; align-items: baseline; gap: 0.45rem; }
.t-label { font-size: 0.72rem; font-weight: 700; color: #64748b; text-transform: uppercase; }
.t-value { font-weight: 600; font-variant-numeric: tabular-nums; }
.t-total .t-value { font-size: 0.95rem; }
</style>
