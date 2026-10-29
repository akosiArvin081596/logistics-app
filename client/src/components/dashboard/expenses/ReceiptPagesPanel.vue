<template>
  <!-- A PDF receipt's pages (driver privacy): which ones reach the driver's
       invoice, the Super Admin's mark per page (no release-all), "Release
       anyway" for a page that shows someone else, and "Update invoice PDF" on
       each invoice holding its pages. Every word comes from the server's codes
       (lib/receiptPages.js); nothing is decided in the browser. Shown only to a
       Super Admin, and only while the server has PDF receipt pages on. -->
  <div v-if="visible" class="rp-panel" @click.stop @keydown.stop>
    <div class="rp-head">
      <span class="rp-title">PDF pages</span>
      <span class="rp-counts">{{ countsText }}</span>
    </div>
    <ul v-if="view && view.pages.length" class="rp-pages">
      <li v-for="p in view.pages" :key="p.page" class="rp-page">
        <span :class="['rp-line', p.released ? 'rp-released' : 'rp-withheld']">{{ pageLine(p) }}</span>
        <span class="rp-actions">
          <button type="button" class="rp-btn" :disabled="busy" @click="openMark(p, 'released')">Release</button>
          <button type="button" class="rp-btn rp-btn-office" :disabled="busy" @click="openMark(p, 'office')">Office only</button>
        </span>
      </li>
    </ul>
    <ul v-if="view && view.invoices.length" class="rp-invoices">
      <li v-for="inv in view.invoices" :key="inv.id" class="rp-invoice">
        <span>{{ invoiceLine(inv) }}</span>
        <button v-if="inv.can_update" type="button" class="rp-btn" :disabled="busy" @click="updateInvoice(inv)">Update invoice PDF</button>
      </li>
    </ul>

    <ConfirmModal
      :open="dialog === 'mark'"
      :title="mark === 'released' ? `Release page ${target && target.page} to the driver` : `Keep page ${target && target.page} with the office`"
      :message="mark === 'released'
        ? 'The page goes on the driver\'s invoice at its next render, or now with Update invoice PDF.'
        : 'The page comes out of every stored invoice PDF that holds it, now.'"
      :confirm-text="mark === 'released' ? 'Release' : 'Office only'"
      :confirm-disabled="busy || !reason"
      @confirm="submitMark()"
      @cancel="close"
    >
      <label class="rp-field">
        <span>Reason</span>
        <select v-model="reason">
          <option value="" disabled>Choose a reason</option>
          <option v-for="r in reasons" :key="r.code" :value="r.code">{{ r.text }}</option>
        </select>
      </label>
      <label class="rp-field">
        <span>Note (staff only, optional)</span>
        <input v-model="note" type="text" maxlength="300" autocomplete="off" />
      </label>
    </ConfirmModal>

    <ConfirmModal
      :open="dialog === 'anyway'"
      title="Release anyway?"
      :message="anywayText"
      confirm-text="Release anyway"
      :confirm-disabled="busy"
      danger
      @confirm="submitMark(anywayCodes)"
      @cancel="close"
    />
  </div>
</template>

<script setup>
import { computed, ref, watch } from 'vue'
import { useApi } from '../../../composables/useApi'
import { useToast } from '../../../composables/useToast'
import { useAuthStore } from '../../../stores/auth'
import ConfirmModal from '../../shared/ConfirmModal.vue'
import {
  RECEIPT_PAGE_MARK_REASONS,
  receiptPagesCountsText,
  receiptPageLine,
  releaseAnywayText,
  receiptPagesInvoiceLine,
  receiptPageMarkToast,
} from '../../../lib/receiptPages'

const props = defineProps({
  expense: { type: Object, required: true },
})

const api = useApi()
const { show: toast } = useToast()
const auth = useAuthStore()

const view = ref(null)
const off = ref(false)
const busy = ref(false)
const dialog = ref('')
const target = ref(null)
const mark = ref('released')
const reason = ref('')
const note = ref('')
const anywayCodes = ref([])
const reasons = RECEIPT_PAGE_MARK_REASONS

const visible = computed(() => !!auth.isSuperAdmin && !off.value && !!view.value)
const countsText = computed(() => receiptPagesCountsText(view.value))
const anywayText = computed(() => releaseAnywayText(anywayCodes.value))
const pageLine = receiptPageLine
const invoiceLine = receiptPagesInvoiceLine

// Rebuilding an invoice PDF reads and writes files in a child process, so the
// writes get longer than the usual 20 s.
const WRITE_TIMEOUT_MS = 90000

async function load() {
  view.value = null
  if (!auth.isSuperAdmin || !props.expense || !props.expense.id) return
  try {
    view.value = await api.get(`/api/expenses/${props.expense.id}/receipt-pages`, { timeout: WRITE_TIMEOUT_MS })
    off.value = false
  } catch (err) {
    // Switched off on this server, or not a PDF: nothing to show.
    if (err && (err.code === 'FEATURE_OFF' || err.code === 'RECEIPT_NOT_PDF')) off.value = true
    else toast((err && err.message) || "The receipt's pages could not be read", 'error')
  }
}

watch(() => props.expense && props.expense.id, load, { immediate: true })

function openMark(page, kind) {
  target.value = page
  mark.value = kind
  reason.value = ''
  note.value = ''
  anywayCodes.value = []
  dialog.value = 'mark'
}

function close() {
  if (!busy.value) dialog.value = ''
}

async function submitMark(releaseAnyway) {
  if (busy.value || !target.value) return
  busy.value = true
  try {
    const body = { mark: mark.value, reason: reason.value, note: note.value }
    if (Array.isArray(releaseAnyway) && releaseAnyway.length) body.releaseAnyway = releaseAnyway
    const res = await api.post(`/api/expenses/${props.expense.id}/receipt-pages/${target.value.page}`, body, { timeout: WRITE_TIMEOUT_MS })
    view.value = res
    dialog.value = ''
    const said = receiptPageMarkToast(res)
    toast(said.text, said.kind)
  } catch (err) {
    if (err && err.code === 'RECEIPT_PAGE_RELEASE_ANYWAY') {
      anywayCodes.value = (err.data && err.data.codes) || []
      dialog.value = 'anyway'
    } else {
      toast((err && err.message) || 'The page was not marked', 'error')
    }
  } finally {
    busy.value = false
  }
}

async function updateInvoice(inv) {
  if (busy.value) return
  busy.value = true
  try {
    const res = await api.post(`/api/invoices/${inv.id}/receipt-pages/update`, {}, { timeout: WRITE_TIMEOUT_MS })
    toast(res.changed ? `${inv.invoice_number || 'The invoice'}: PDF updated` : 'Nothing to update', 'success')
    await load()
  } catch (err) {
    toast((err && err.message) || 'The invoice PDF was not updated', 'error')
  } finally {
    busy.value = false
  }
}
</script>

<style scoped>
.rp-panel {
  margin-top: 0.75rem;
  padding: 0.6rem 0.75rem;
  border: 1px solid #e5e7eb;
  border-radius: 8px;
  font-size: 0.8rem;
  text-align: left;
}
.rp-head { display: flex; flex-wrap: wrap; gap: 0.5rem; align-items: baseline; }
.rp-title { font-weight: 700; }
.rp-counts { color: #4b5563; }
.rp-pages,
.rp-invoices { list-style: none; margin: 0.5rem 0 0; padding: 0; display: flex; flex-direction: column; gap: 0.35rem; }
.rp-page,
.rp-invoice { display: flex; flex-wrap: wrap; gap: 0.4rem; align-items: center; justify-content: space-between; }
.rp-released { color: #065f46; }
.rp-withheld { color: #92400e; }
.rp-actions { display: inline-flex; gap: 0.3rem; }
.rp-btn {
  padding: 0.15rem 0.5rem;
  border-radius: 6px;
  font-size: 0.72rem;
  font-weight: 600;
  cursor: pointer;
  border: 1px solid #9ca3af;
  background: #fff;
  color: #374151;
}
.rp-btn-office { border-color: #d97706; background: #fffbeb; color: #92400e; }
.rp-btn:disabled { opacity: 0.5; cursor: default; }
.rp-field { display: flex; flex-direction: column; gap: 0.25rem; margin-top: 0.5rem; font-size: 0.8rem; text-align: left; }
.rp-field input,
.rp-field select { padding: 0.4rem 0.5rem; border: 1px solid #d1d5db; border-radius: 6px; font-size: 0.9rem; }
</style>
