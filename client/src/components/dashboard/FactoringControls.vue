<template>
  <!-- Factored loads (Triumph): the chip, and for a listed account "Factor with Triumph",
       "Clear factored" and "Handled in Triumph's process", each where the server says so
       (canMark, canClear, canRecordOutside); a Super Admin who isn't listed sees the chip
       only. With Process with Triumph on, a load goes to Triumph only through its button,
       so the server gives no canMark, and Clear factored stays on its own. -->
  <div v-if="auth.isSuperAdmin && (chip || mayFactor || mayClear || mayRecord || result)" class="fact-line" :class="chip ? `fact-line--${chip.tone}` : ''">
    <span v-if="chip" class="fact-text"><strong>{{ chip.label }}.</strong> {{ chip.reason }}</span>
    <span v-else class="fact-text">Not factored.</span>
    <p v-if="mayFactor" class="fact-note">Mark before the driver taps Delivered. After the invoice goes out, this can't be undone here.</p>
    <div v-if="mayMark || mayClear || mayRecord" class="fact-actions">
      <input v-model="reason" class="fact-reason" type="text" maxlength="200" :placeholder="hint" aria-label="Reason" :disabled="busy" />
      <button v-if="mayMark" type="button" class="fact-btn" :disabled="busy || !reasonOk" @click="setFactored(true)">Factor with Triumph</button>
      <button v-if="mayClear" type="button" class="fact-btn" :disabled="busy || !reasonOk" @click="setFactored(false)">Clear factored</button>
      <button v-if="mayRecord" type="button" class="fact-btn" :disabled="busy || !reasonOk" @click="recordOutside">Handled in Triumph's process</button>
    </div>
    <div v-if="result" class="fact-result" :class="`fact-result--${result.tone}`" :role="result.tone === 'error' ? 'alert' : 'status'">{{ result.msg }}</div>
  </div>
</template>

<script setup>
import { computed, ref, watch } from 'vue'
import { useApi } from '../../composables/useApi'
import { useAuthStore } from '../../stores/auth'
import { factoringChip, canFactor, canMarkFactored, canClear, canRecordOutside, notSentQuestion, reasonInput, reasonHint } from '../../lib/factoringStatus'
import { draftMayBeOut } from '../../lib/autoInvoiceStatus'

const props = defineProps({
  // The dashboard row, with the server's `_factoring`.
  job: { type: Object, default: null },
  loadId: { type: String, default: '' },
})
const emit = defineEmits(['changed'])
const api = useApi()
const auth = useAuthStore()

const status = computed(() => (props.job && props.job._factoring) || null)
const chip = computed(() => factoringChip(status.value, { draftMayBeOut: draftMayBeOut(props.job && props.job._autoInvoice) }))
const mayFactor = computed(() => canFactor(status.value))
const mayMark = computed(() => canMarkFactored(status.value))
const mayClear = computed(() => canClear(status.value))
const mayRecord = computed(() => canRecordOutside(status.value))
const reason = ref('')
const reasonOk = computed(() => reasonInput(reason.value).length > 0)
const hint = computed(() => reasonHint(auth.user?.username))
const busy = ref(false)
const result = ref(null)
watch(() => props.loadId, () => { reason.value = ''; result.value = null })

const keyPath = () => `/api/factoring/loads/${encodeURIComponent(props.loadId)}`

async function setFactored(next) {
  if (!auth.isSuperAdmin || !props.loadId || busy.value || !reasonOk.value) return
  busy.value = true; result.value = null
  const body = { factored: next, reason: reasonInput(reason.value), loadId: props.loadId }
  let asked = false
  try {
    try {
      await api.post(keyPath(), body)
    } catch (e) {
      // A draft exists, or may: marking needs a person to say it was never sent.
      const question = next && e ? notSentQuestion(e.code) : ''
      if (!question) throw e
      if (!window.confirm(question)) {
        result.value = { tone: 'error', msg: (e && e.message) || 'Not marked.' }
        return
      }
      asked = true
      await api.post(keyPath(), { ...body, confirmNotSent: true })
    }
    const marked = asked ? 'Marked factored. If a draft is in Gmail Drafts, delete it.' : 'Marked factored: its invoice goes through Triumph.'
    // A load Process with Triumph took was invoiced to the broker already: clearing keeps it there.
    const cleared = status.value && status.value.byButton === true
      ? 'No longer factored: it stays with its invoice to the broker.'
      : 'No longer factored. If it is already delivered, draft its invoice by hand.'
    result.value = { tone: 'ok', msg: next ? marked : cleared }
    reason.value = ''
    // The row as it now stands, until the dashboard's next read.
    const listed = Boolean(status.value && (status.value.canMark || status.value.canRecordOutside || status.value.canClear))
    const switchOn = Boolean(status.value && status.value.canClear !== undefined)
    emit('changed', { ...(status.value || {}), factored: next, canRecordOutside: next && listed, ...(switchOn ? { canClear: false, canRetry: false } : {}) })
  } catch (e) {
    result.value = { tone: 'error', msg: (e && e.message) || 'That did not go through. Try again.' }
  } finally {
    busy.value = false
  }
}

async function recordOutside() {
  if (!auth.isSuperAdmin || !props.loadId || busy.value || !reasonOk.value) return
  if (!window.confirm("Record that this load was handled in Triumph's own process? It becomes final: the app never invoices it.")) return
  busy.value = true; result.value = null
  try {
    await api.post(`${keyPath()}/handled-outside`, { reason: reasonInput(reason.value), loadId: props.loadId })
    result.value = { tone: 'ok', msg: "Recorded as handled in Triumph's process." }
    reason.value = ''
    emit('changed', { ...(status.value || {}), locked: true, lockedVia: 'outside', canMark: false, canRecordOutside: false })
  } catch (e) {
    result.value = { tone: 'error', msg: (e && e.message) || 'That did not go through. Try again.' }
  } finally {
    busy.value = false
  }
}
</script>

<style scoped>
.fact-line {
  margin-top: 0.5rem;
  font-size: 0.78rem;
  padding: 0.4rem 0.6rem;
  border-radius: 6px;
  border: 1px solid #e5e7eb;
  background: #f9fafb;
  color: #374151;
}
.fact-line--warn { background: #fffbeb; border-color: #fde68a; color: #92400e; }
.fact-line--muted { background: #f3f4f6; border-color: #e5e7eb; color: #4b5563; }
.fact-note { margin: 0.25rem 0 0; font-weight: 600; }
.fact-actions { display: flex; flex-wrap: wrap; gap: 0.4rem; margin-top: 0.4rem; align-items: center; }
.fact-reason { flex: 1 1 12rem; min-width: 0; font-size: 0.78rem; padding: 0.25rem 0.4rem; border: 1px solid #d1d5db; border-radius: 4px; background: #fff; }
.fact-btn { font-size: 0.75rem; font-weight: 600; padding: 0.25rem 0.6rem; border: 1px solid #d1d5db; border-radius: 4px; background: #fff; cursor: pointer; }
.fact-btn:disabled { opacity: 0.55; cursor: not-allowed; }
.fact-result { margin-top: 0.35rem; font-weight: 600; }
.fact-result--ok { color: #166534; }
.fact-result--error { color: #b91c1c; }
</style>
