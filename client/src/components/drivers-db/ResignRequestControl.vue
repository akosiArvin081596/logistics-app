<template>
  <!-- "Ask to sign again" on one signed policy document (ONBOARDING_RESIGN_ENABLED).
       DriverTable renders this only when a Super Admin's documents answer carries the
       request keys; what it shows comes from those keys alone (staffState()). -->
  <div v-if="state !== 'none'" class="resign-ctl">
    <template v-if="state === 'requested'">
      <div class="resign-open">
        Asked to sign again<span v-if="doc.resign.requestedAt"> · {{ fmtTimestamp(doc.resign.requestedAt) }}</span><span v-if="doc.resign.requestedBy"> by {{ doc.resign.requestedBy }}</span>
      </div>
      <div class="resign-line">Reason: {{ doc.resign.reason }}</div>
      <div v-if="doc.resign.error" class="resign-line resign-failed">
        Last try failed<span v-if="doc.resign.failedAt"> {{ fmtTimestamp(doc.resign.failedAt) }}</span>: {{ doc.resign.error }}
      </div>
      <button type="button" class="resign-btn" :disabled="busy" @click="withdraw">{{ busy ? 'Withdrawing...' : 'Withdraw request' }}</button>
    </template>
    <template v-else>
      <button v-if="!asking" type="button" class="resign-btn" @click="startAsking">Ask to sign again</button>
      <form v-else class="resign-form" @submit.prevent="send">
        <p class="resign-help">The signed original stays on file as history. The driver is told in the app only: no email or text.</p>
        <label class="resign-label" :for="reasonId">Reason (kept with the request, never shown to the driver)</label>
        <textarea
          :id="reasonId"
          v-model="reason"
          class="resign-input"
          rows="2"
          :maxlength="REASON_MAX"
          placeholder="For example: the printed name was cut off in its box."
        ></textarea>
        <div class="resign-actions">
          <button type="button" class="resign-btn" :disabled="busy" @click="asking = false">Cancel</button>
          <button type="submit" class="resign-btn resign-primary" :disabled="busy || !!problem">{{ busy ? 'Sending...' : 'Send request' }}</button>
        </div>
      </form>
    </template>
    <p v-if="message" class="resign-msg" role="alert">{{ message }}</p>
  </div>
</template>

<script setup>
import { computed, ref, useId } from 'vue'
import { useApi } from '../../composables/useApi'
import { fmtTimestamp } from '../../utils/datetime'
import { REASON_MAX, cancelUrl, reasonProblem, requestUrl, staffState } from '../../lib/resignRequest'

const props = defineProps({
  // One row of GET /api/drivers-directory/:id/documents, with `resign` and `resignable`.
  doc: { type: Object, required: true },
  // That answer's userId: the driver account the request goes to.
  userId: { type: Number, required: true },
})
const emit = defineEmits(['changed'])

const api = useApi()
const reasonId = useId()
const asking = ref(false)
const reason = ref('')
const busy = ref(false)
const message = ref('')
const state = computed(() => staffState(props.doc))
const problem = computed(() => reasonProblem(reason.value))

function startAsking() {
  asking.value = true
  reason.value = ''
  message.value = ''
}

async function send() {
  if (busy.value || problem.value) return
  busy.value = true
  message.value = ''
  try {
    await api.post(requestUrl(props.userId, props.doc.doc_key), { reason: reason.value.trim() })
    asking.value = false
    reason.value = ''
    emit('changed')
  } catch (err) {
    message.value = err?.message || 'The request could not be sent.'
  } finally {
    busy.value = false
  }
}

async function withdraw() {
  if (busy.value) return
  busy.value = true
  message.value = ''
  try {
    await api.post(cancelUrl(props.userId, props.doc.doc_key), {})
    emit('changed')
  } catch (err) {
    message.value = err?.message || 'The request could not be withdrawn.'
  } finally {
    busy.value = false
  }
}
</script>

<style scoped>
.resign-ctl { margin-top: 0.45rem; display: flex; flex-direction: column; gap: 0.3rem; align-items: flex-start; }
.resign-open { font-size: 0.72rem; font-weight: 700; color: #92400e; }
.resign-line { font-size: 0.72rem; color: #64748b; overflow-wrap: anywhere; }
.resign-failed { color: #b91c1c; }
.resign-form { display: flex; flex-direction: column; gap: 0.35rem; width: 100%; }
.resign-help { font-size: 0.72rem; color: #64748b; margin: 0; line-height: 1.4; }
.resign-label { font-size: 0.68rem; font-weight: 600; color: var(--text-dim); text-transform: uppercase; letter-spacing: 0.04em; }
.resign-input {
  width: 100%; padding: 0.45rem 0.6rem; border: 1px solid var(--border); border-radius: 6px;
  font-family: inherit; font-size: 0.8rem; background: var(--bg); color: var(--text); resize: vertical;
}
.resign-input:focus { outline: none; border-color: var(--blue); }
.resign-actions { display: flex; gap: 0.35rem; justify-content: flex-end; }
.resign-btn {
  font-size: 0.72rem; font-weight: 600; color: #0ea5e9; background: #f0f9ff;
  padding: 0.3rem 0.65rem; border: 1px solid #bae6fd; border-radius: 6px;
  cursor: pointer; font-family: inherit;
}
.resign-btn:hover:not(:disabled) { background: #e0f2fe; }
.resign-btn:disabled { opacity: 0.5; cursor: not-allowed; }
.resign-primary { color: #fff; background: #0f2847; border-color: #0f2847; }
.resign-primary:hover:not(:disabled) { background: #1a3a6b; }
.resign-msg { font-size: 0.72rem; color: #b91c1c; margin: 0; }
</style>
