<template>
  <!-- Advance lines (B20): money the broker already paid on this load, printed on
       this invoice only. Shown by the invoice editor only when the server's dryRun
       carried `invoiceLines` (BROKER_INVOICE_LINES_ENABLED on). Every figure here
       is the server's: the editor ticks lines and the server answers with the
       line haul, the advances and the balance due. -->
  <section class="ial" aria-labelledby="ial-title">
    <div id="ial-title" class="ial-label">
      Advance lines
      <span class="ial-badge">Invoice only</span>
    </div>
    <p class="ial-hint">
      Money the broker already paid, printed on this invoice as a deduction.
      Job Tracking, revenue, driver pay, investor payouts and the P&amp;L keep the line haul.
    </p>

    <ul v-if="activeLines.length" class="ial-list">
      <li v-for="line in activeLines" :key="line.id" class="ial-item">
        <label class="ial-check">
          <input
            type="checkbox"
            :checked="selectedIds.includes(line.id)"
            :disabled="disabled || addBusy || voidBusy"
            @change="toggle(line.id, $event.target.checked)"
          />
          <span class="ial-item-main">
            <span class="ial-item-title">{{ line.label }}</span>
            <span class="ial-item-sub">
              <template v-if="line.receivedOn">Received {{ fmtDay(line.receivedOn) }}</template>
              <template v-if="line.receivedOn && line.reference"> · </template>
              <template v-if="line.reference">Ref {{ line.reference }}</template>
              <template v-if="line.invoiceId"> · printed on {{ line.invoiceId }}</template>
            </span>
            <span v-if="line.note" class="ial-item-note">{{ line.note }}</span>
          </span>
          <span class="ial-amt">{{ line.amount }}</span>
        </label>
        <div class="ial-item-actions">
          <button
            v-if="voidingId !== line.id"
            type="button"
            class="ial-btn ial-btn-ghost"
            :disabled="disabled || voidBusy"
            @click="startVoid(line)"
          >Void</button>
        </div>
        <div v-if="voidingId === line.id" class="ial-void">
          <label class="ial-label" :for="`ial-void-${line.id}`">Why is it voided?</label>
          <input
            :id="`ial-void-${line.id}`"
            v-model="voidReason"
            type="text"
            class="ial-input"
            :class="{ 'is-invalid': voidTouched && !!voidReasonErr }"
            :maxlength="VOID_REASON_MAX"
            autocomplete="off"
            :disabled="disabled || voidBusy"
            placeholder="Entered twice"
          />
          <p v-if="voidTouched && voidReasonErr" class="ial-hint ial-hint-warn">{{ voidReasonErr }}</p>
          <p v-if="voidError" class="ial-hint ial-hint-warn" role="alert">{{ voidError }}</p>
          <p class="ial-hint">A voided line is kept for the record and is never printed again. A draft that already printed it keeps its copy.</p>
          <div class="ial-row">
            <button type="button" class="ial-btn ial-btn-ghost" :disabled="voidBusy" @click="cancelVoid">Keep it</button>
            <button type="button" class="ial-btn ial-btn-danger" :disabled="disabled || voidBusy" @click="confirmVoid(line)">
              {{ voidBusy ? 'Voiding…' : 'Void line' }}
            </button>
          </div>
        </div>
      </li>
    </ul>
    <p v-else class="ial-hint">No advance lines on this load.</p>
    <p v-if="voidedCount" class="ial-hint">{{ voidedCount }} voided {{ voidedCount === 1 ? 'line is' : 'lines are' }} kept for the record.</p>

    <div v-for="w in shownWarnings" :key="`${w.lineId}-${w.expenseId}`" class="ial-warn" role="status">
      <strong>A receipt on this load has the same amount.</strong>
      Receipt #{{ w.expenseId }} ({{ w.type }}, {{ w.amount }}, {{ w.status || 'no status' }}) matches advance line #{{ w.lineId }}.
      If it is this advance, it counts as a trip cost while revenue stays at the line haul. Nothing is changed by this warning.
    </div>

    <!-- The figures, exactly as the server's last dryRun or preview answered. -->
    <dl v-if="summary" class="ial-totals">
      <div><dt>Line haul</dt><dd>{{ summary.lineHaul }}</dd></div>
      <div><dt>Less advances</dt><dd>{{ summary.advances }}</dd></div>
      <div class="ial-balance"><dt>Balance due</dt><dd>{{ summary.balanceDue }}</dd></div>
    </dl>
    <p v-else-if="selectedIds.length && !error" class="ial-hint">The balance due shows once the preview updates.</p>
    <div v-if="error" class="ial-warn" role="status">
      <strong>These lines can't be printed as they are.</strong>
      {{ error.message }}
    </div>

    <div v-if="selectedIds.length" class="ial-field">
      <label class="ial-label" for="ial-footnote">
        Footnote
        <span class="ial-label-aside">printed under the balance due</span>
      </label>
      <textarea
        id="ial-footnote"
        :value="footnote"
        rows="2"
        class="ial-input ial-textarea"
        :class="{ 'is-invalid': !!footnoteErr }"
        :maxlength="FOOTNOTE_MAX"
        :disabled="disabled"
        @input="emit('update:footnote', $event.target.value)"
      ></textarea>
      <div class="ial-row ial-row-start">
        <p v-if="footnoteErr" class="ial-hint ial-hint-warn">{{ footnoteErr }}</p>
        <button
          v-if="footnoteDefault && footnote.trim() !== footnoteDefault.trim()"
          type="button"
          class="ial-btn ial-btn-ghost ial-btn-small"
          :disabled="disabled"
          @click="emit('update:footnote', footnoteDefault)"
        >Use the default</button>
        <span class="ial-hint ial-count">{{ footnoteLength }} / {{ FOOTNOTE_MAX }}</span>
      </div>
    </div>

    <button v-if="!adding" type="button" class="ial-btn ial-btn-ghost" :disabled="disabled" @click="startAdd">Add advance</button>
    <form v-else class="ial-add" novalidate @submit.prevent="submitAdd">
      <div class="ial-field">
        <label class="ial-label" for="ial-add-label">Label</label>
        <input id="ial-add-label" v-model="addForm.label" type="text" class="ial-input" :class="{ 'is-invalid': addTouched && !!addErrors.label }"
          :maxlength="LINE_LABEL_MAX" autocomplete="off" :disabled="disabled || addBusy" />
        <p v-if="addTouched && addErrors.label" class="ial-hint ial-hint-warn">{{ addErrors.label }}</p>
      </div>
      <div class="ial-field">
        <label class="ial-label" for="ial-add-amount">Amount</label>
        <input id="ial-add-amount" v-model="addForm.amount" type="text" inputmode="decimal" class="ial-input" :class="{ 'is-invalid': addTouched && !!addErrors.amount }"
          autocomplete="off" placeholder="650.00" :disabled="disabled || addBusy" />
        <p v-if="addTouched && addErrors.amount" class="ial-hint ial-hint-warn">{{ addErrors.amount }}</p>
      </div>
      <div class="ial-field">
        <label class="ial-label" for="ial-add-date">Received on <span class="ial-label-aside">optional</span></label>
        <input id="ial-add-date" v-model="addForm.receivedOn" type="date" class="ial-input" :class="{ 'is-invalid': addTouched && !!addErrors.receivedOn }"
          :disabled="disabled || addBusy" />
        <p v-if="addTouched && addErrors.receivedOn" class="ial-hint ial-hint-warn">{{ addErrors.receivedOn }}</p>
      </div>
      <div class="ial-field">
        <label class="ial-label" for="ial-add-ref">Reference <span class="ial-label-aside">optional, e.g. the check #</span></label>
        <input id="ial-add-ref" v-model="addForm.reference" type="text" class="ial-input" :class="{ 'is-invalid': addTouched && !!addErrors.reference }"
          :maxlength="LINE_REFERENCE_MAX" autocomplete="off" :disabled="disabled || addBusy" />
        <p v-if="addTouched && addErrors.reference" class="ial-hint ial-hint-warn">{{ addErrors.reference }}</p>
      </div>
      <div class="ial-field">
        <label class="ial-label" for="ial-add-note">Internal note <span class="ial-label-aside">optional, not printed</span></label>
        <textarea id="ial-add-note" v-model="addForm.note" rows="2" class="ial-input ial-textarea" :class="{ 'is-invalid': addTouched && !!addErrors.note }"
          :maxlength="LINE_NOTE_MAX" :disabled="disabled || addBusy"></textarea>
        <p v-if="addTouched && addErrors.note" class="ial-hint ial-hint-warn">{{ addErrors.note }}</p>
      </div>
      <p v-if="addError" class="ial-hint ial-hint-warn" role="alert">{{ addError }}</p>
      <p class="ial-hint">Saved now and recorded in the audit log; it prints once you approve the invoice.</p>
      <div class="ial-row">
        <button type="button" class="ial-btn ial-btn-ghost" :disabled="addBusy" @click="adding = false">Cancel</button>
        <button type="submit" class="ial-btn ial-btn-primary" :disabled="disabled || addBusy">{{ addBusy ? 'Saving…' : 'Save advance' }}</button>
      </div>
    </form>
  </section>
</template>

<script setup>
import { computed, reactive, ref } from 'vue'
import { useApi } from '../../composables/useApi'
import {
  DEFAULT_ADVANCE_LABEL, LINE_LABEL_MAX, LINE_REFERENCE_MAX, LINE_NOTE_MAX, FOOTNOTE_MAX, VOID_REASON_MAX,
  footnoteError, newLineBody, newLineErrors, voidReasonError,
} from '../../lib/invoiceLines'

const props = defineProps({
  loadId: { type: String, required: true },
  // The load's lines as the server lists them (voided ones included).
  available: { type: Array, default: () => [] },
  // Ids of the lines this invoice prints, in the order they are listed.
  selectedIds: { type: Array, default: () => [] },
  footnote: { type: String, default: '' },
  // The server's footnote for the ticked lines.
  footnoteDefault: { type: String, default: '' },
  // The server's figures for the ticked lines (summaryWire), or null.
  summary: { type: Object, default: null },
  // The server's refusal of the ticked lines ({ code, message }), or null.
  error: { type: Object, default: null },
  receiptWarnings: { type: Array, default: () => [] },
  disabled: { type: Boolean, default: false },
})
const emit = defineEmits(['update:available', 'update:selectedIds', 'update:footnote'])

const api = useApi()

const activeLines = computed(() => props.available.filter((l) => l && !l.voided))
const voidedCount = computed(() => props.available.filter((l) => l && l.voided).length)
const activeIds = computed(() => activeLines.value.map((l) => l.id))
const shownWarnings = computed(() => props.receiptWarnings.filter((w) => w && activeIds.value.includes(w.lineId)))
const footnoteErr = computed(() => footnoteError(props.footnote))
const footnoteLength = computed(() => String(props.footnote || '').normalize('NFC').length)

// "YYYY-MM-DD" shown as MM/DD/YYYY, by string surgery (a day has no zone).
function fmtDay(iso) {
  const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(String(iso || ''))
  return m ? `${m[2]}/${m[3]}/${m[1]}` : String(iso || '')
}

// Ticked lines stay in list order, which is the order they print in.
function toggle(id, on) {
  emit('update:selectedIds', activeIds.value.filter((x) => (x === id ? on : props.selectedIds.includes(x))))
}

// ── adding ────────────────────────────────────────────────────────────────────
const adding = ref(false)
const addBusy = ref(false)
const addTouched = ref(false)
const addError = ref('')
const blankLine = () => ({ label: DEFAULT_ADVANCE_LABEL, amount: '', receivedOn: '', reference: '', note: '' })
const addForm = reactive(blankLine())
const addErrors = computed(() => newLineErrors(addForm))

function startAdd() {
  Object.assign(addForm, blankLine())
  addTouched.value = false
  addError.value = ''
  adding.value = true
}

// POST once; the server stores the line, audits it and answers with it. A
// saved line is ticked at once, which re-renders the invoice.
async function submitAdd() {
  addTouched.value = true
  if (addBusy.value || Object.keys(addErrors.value).length) return
  addBusy.value = true
  addError.value = ''
  try {
    const r = await api.post(`/api/loads/${encodeURIComponent(props.loadId)}/invoice-lines`, newLineBody(addForm))
    const line = r && r.line
    if (!line || !line.id) throw new Error('The server did not return the saved line. Close the editor and open it again to see it.')
    emit('update:available', [...props.available, line])
    emit('update:selectedIds', [...activeIds.value, line.id].filter((x) => x === line.id || props.selectedIds.includes(x)))
    adding.value = false
  } catch (e) {
    addError.value = (e && e.message) || 'The line could not be saved.'
  } finally {
    addBusy.value = false
  }
}

// ── voiding ───────────────────────────────────────────────────────────────────
const voidingId = ref(null)
const voidReason = ref('')
const voidTouched = ref(false)
const voidBusy = ref(false)
const voidError = ref('')
const voidReasonErr = computed(() => voidReasonError(voidReason.value))

function startVoid(line) {
  voidingId.value = line.id
  voidReason.value = ''
  voidTouched.value = false
  voidError.value = ''
}
function cancelVoid() {
  voidingId.value = null
}
async function confirmVoid(line) {
  voidTouched.value = true
  if (voidBusy.value || voidReasonErr.value) return
  voidBusy.value = true
  voidError.value = ''
  try {
    const r = await api.post(`/api/loads/${encodeURIComponent(props.loadId)}/invoice-lines/${encodeURIComponent(String(line.id))}/void`, { reason: voidReason.value })
    const updated = r && r.line
    if (!updated || !updated.voided) throw new Error('The server did not confirm the void. Close the editor and open it again to see the line.')
    emit('update:available', props.available.map((l) => (l.id === updated.id ? updated : l)))
    if (props.selectedIds.includes(updated.id)) emit('update:selectedIds', props.selectedIds.filter((x) => x !== updated.id))
    voidingId.value = null
  } catch (e) {
    voidError.value = (e && e.message) || 'The line could not be voided.'
  } finally {
    voidBusy.value = false
  }
}
</script>

<style scoped>
/* The invoice editor's own look (InvoiceDraftPreviewModal.vue's idp-* rules),
   restated here because that file's styles are scoped to it. */
.ial { display: flex; flex-direction: column; gap: 0.5rem; padding: 0.75rem; border: 1px solid #e2e8f0; border-radius: 10px; background: #fcfdff; }
.ial-label {
  display: flex; align-items: center; gap: 0.4rem; flex-wrap: wrap;
  font-size: 0.72rem; font-weight: 700; text-transform: uppercase; letter-spacing: 0.04em; color: #64748b;
}
.ial-label-aside { font-weight: 500; text-transform: none; letter-spacing: 0; color: #94a3b8; }
.ial-badge {
  padding: 1px 7px; font-size: 0.62rem; font-weight: 700; text-transform: none; letter-spacing: 0;
  border-radius: 999px; border: 1px solid #bfdbfe; background: #eff6ff; color: #1d4ed8; white-space: nowrap;
}
.ial-hint { font-size: 0.72rem; color: #64748b; margin: 0; }
.ial-hint-warn { color: #b45309; }
.ial-list { list-style: none; margin: 0; padding: 0; display: flex; flex-direction: column; gap: 0.4rem; }
.ial-item { display: flex; flex-wrap: wrap; align-items: flex-start; gap: 0.4rem; padding: 0.5rem 0.6rem; border: 1px solid #e8edf2; border-radius: 8px; background: #fff; }
.ial-check { display: flex; align-items: flex-start; gap: 0.55rem; flex: 1 1 14rem; min-width: 0; cursor: pointer; }
.ial-check input { margin-top: 0.2rem; }
.ial-item-main { display: flex; flex-direction: column; min-width: 0; flex: 1 1 auto; }
.ial-item-title { font-size: 0.85rem; font-weight: 600; color: #0f2847; overflow-wrap: anywhere; }
.ial-item-sub, .ial-item-note { font-size: 0.72rem; color: #64748b; overflow-wrap: anywhere; }
.ial-item-note { white-space: pre-wrap; }
.ial-amt { font-size: 0.85rem; font-weight: 600; color: #1f2937; font-variant-numeric: tabular-nums; white-space: nowrap; }
.ial-item-actions { margin-left: auto; }
.ial-void { flex: 1 1 100%; display: flex; flex-direction: column; gap: 0.35rem; padding-top: 0.35rem; border-top: 1px dashed #e2e8f0; }
.ial-totals { margin: 0; display: flex; flex-direction: column; gap: 0.2rem; padding: 0.5rem 0.6rem; border-radius: 8px; background: #f8fafc; }
.ial-totals > div { display: flex; justify-content: space-between; gap: 0.75rem; font-size: 0.82rem; color: #475569; }
.ial-totals dt, .ial-totals dd { margin: 0; }
.ial-totals dd { font-variant-numeric: tabular-nums; color: #1f2937; }
.ial-balance { font-weight: 700; color: #0f2847; }
.ial-balance dd { color: #0f2847; }
.ial-field { display: flex; flex-direction: column; gap: 0.3rem; }
.ial-add { display: flex; flex-direction: column; gap: 0.55rem; padding-top: 0.25rem; }
.ial-input {
  width: 100%; padding: 0.5rem 0.65rem; font-family: inherit; font-size: 0.88rem; color: #1a1d27;
  background: #fff; border: 1px solid #d1d5db; border-radius: 8px;
}
.ial-input:focus { outline: none; border-color: #38bdf8; box-shadow: 0 0 0 3px rgba(56, 189, 248, 0.12); }
.ial-input:disabled { background: #f9fafb; color: #6b7085; }
.ial-input.is-invalid { border-color: #dc2626; background: #fffafa; }
.ial-textarea { display: block; min-height: 3.2rem; line-height: 1.4; resize: vertical; }
.ial-row { display: flex; align-items: center; justify-content: flex-end; gap: 0.5rem; flex-wrap: wrap; }
.ial-row-start { justify-content: flex-start; }
.ial-count { margin-left: auto; white-space: nowrap; font-variant-numeric: tabular-nums; }
.ial-warn {
  padding: 0.55rem 0.75rem; border-radius: 8px; font-size: 0.78rem; line-height: 1.45;
  background: #fffbeb; border: 1px solid #fde68a; color: #92400e;
}
.ial-warn strong { display: block; font-weight: 600; margin-bottom: 0.15rem; }
.ial-btn {
  display: inline-flex; align-items: center; justify-content: center; gap: 0.4rem; align-self: flex-start;
  padding: 0.45rem 0.9rem; font-family: inherit; font-size: 0.8rem; font-weight: 600; border-radius: 8px; cursor: pointer;
}
.ial-btn:disabled { opacity: 0.6; cursor: not-allowed; }
.ial-btn-small { padding: 0.25rem 0.6rem; font-size: 0.72rem; }
.ial-btn-ghost { border: 1px solid #d1d5db; background: #fff; color: #374151; }
.ial-btn-ghost:hover:not(:disabled) { background: #f9fafb; }
.ial-btn-primary { border: 1px solid #0f2847; background: #0f2847; color: #fff; }
.ial-btn-primary:hover:not(:disabled) { background: #17385f; }
.ial-btn-danger { border: 1px solid #b91c1c; background: #fff; color: #b91c1c; }
.ial-btn-danger:hover:not(:disabled) { background: #fef2f2; }
</style>
