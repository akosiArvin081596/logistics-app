<template>
  <!-- A driver's recorded time off (R11): list, add, end early, cancel. The
       server owns every rule (dates, the 60-day cap, a Dispatcher's 30-day and
       end-early limits, overlaps) and answers in words; this shows them as
       sent. Rendered only by screens whose data says availability is on. -->
  <section class="avail" aria-label="Time off">
    <div class="avail-head">
      <h4 class="avail-title">Time off</h4>
      <span v-if="loading" class="avail-muted">Loading…</span>
    </div>
    <p v-if="error" class="avail-error" role="alert">{{ error }}</p>

    <ul v-if="live.length" class="avail-list">
      <li v-for="r in live" :key="r.id" class="avail-row">
        <div class="avail-row-main">
          <span class="avail-range">{{ availabilityRangeText(r.from, r.to) }}</span>
          <span :class="['avail-tag', r.status === 'current' ? 'avail-tag-now' : 'avail-tag-next']">{{ r.status === 'current' ? 'Off now' : 'Upcoming' }}</span>
          <span class="avail-kind">{{ kindLabel(r.kind) }}</span>
          <span v-if="r.reason" class="avail-reason">{{ r.reason }}</span>
        </div>
        <div v-if="endingId === r.id" class="avail-end">
          <label class="avail-label">
            Last day off
            <input v-model="endTo" type="date" class="avail-input" :min="r.from" :max="r.to" />
          </label>
          <div class="avail-actions">
            <button type="button" class="btn btn-secondary" :disabled="busy" @click="endingId = null">Back</button>
            <button type="button" class="btn btn-primary" :disabled="busy || !endTo" @click="saveEnd(r)">Save</button>
          </div>
        </div>
        <div v-else class="avail-actions">
          <button type="button" class="btn btn-secondary" :disabled="busy" @click="startEnd(r)">End early</button>
          <button type="button" class="btn btn-secondary" :disabled="busy" @click="pendingCancel = r">Cancel</button>
        </div>
      </li>
    </ul>
    <p v-else-if="!loading && !error" class="avail-muted">No time off recorded from today on.</p>

    <form class="avail-form" @submit.prevent="add">
      <div class="avail-grid">
        <label class="avail-label">
          Kind
          <select v-model="form.kind" class="avail-input">
            <option v-for="k in AVAILABILITY_KINDS" :key="k.value" :value="k.value">{{ k.label }}</option>
          </select>
        </label>
        <label class="avail-label">
          First day off
          <input v-model="form.from" type="date" class="avail-input" required />
        </label>
        <label class="avail-label">
          Last day off
          <input v-model="form.to" type="date" class="avail-input" :min="form.from || undefined" required />
        </label>
        <label class="avail-label">
          Reason (optional)
          <input v-model="form.reason" type="text" maxlength="200" class="avail-input" autocomplete="off" />
          <span class="avail-hint">Type of leave only (for example vacation or family). No medical details.</span>
        </label>
      </div>
      <div class="avail-actions">
        <button type="submit" class="btn btn-primary" :disabled="busy || !dirId || !form.from || !form.to">Add time off</button>
      </div>
    </form>

    <details v-if="past.length" class="avail-past">
      <summary>Past and cancelled ({{ past.length }})</summary>
      <ul class="avail-list">
        <li v-for="r in past" :key="r.id" class="avail-row avail-row-past">
          <span class="avail-range">{{ availabilityRangeText(r.from, r.to) }}</span>
          <span class="avail-kind">{{ kindLabel(r.kind) }}</span>
          <span class="avail-muted">{{ r.status === 'cancelled' ? 'Cancelled' : 'Ended' }}</span>
        </li>
      </ul>
    </details>

    <ConfirmModal
      :open="!!pendingCancel"
      title="Cancel this time off?"
      :message="pendingCancel ? `${driverName || 'This driver'}: ${availabilityRangeText(pendingCancel.from, pendingCancel.to)}. The record stays, marked cancelled.` : ''"
      confirm-text="Cancel time off"
      cancel-text="Keep it"
      :danger="true"
      @confirm="confirmCancel"
      @cancel="pendingCancel = null"
    />
  </section>
</template>

<script setup>
import { computed, reactive, ref, watch } from 'vue'
import { useApi } from '../../composables/useApi'
import { normDriver } from '../../lib/driverName'
import { AVAILABILITY_KINDS, availabilityRangeText, kindLabel } from '../../lib/availabilityText'
import ConfirmModal from '../shared/ConfirmModal.vue'

// `directoryId` when the caller has it (the Drivers page); otherwise the
// driver is found in the directory by name (the dashboard's Fleet & Drivers).
const props = defineProps({
  directoryId: { type: Number, default: null },
  driverName: { type: String, default: '' },
})
const emit = defineEmits(['changed'])
const api = useApi()

const resolvedId = ref(null)
const dirId = computed(() => props.directoryId || resolvedId.value)
const rows = ref([])
const today = ref('')
const loading = ref(false)
const busy = ref(false)
const error = ref('')
const form = reactive({ kind: 'vacation', from: '', to: '', reason: '' })
const endingId = ref(null)
const endTo = ref('')
const pendingCancel = ref(null)

const live = computed(() => rows.value.filter((r) => r.status === 'current' || r.status === 'upcoming')
  .slice().sort((a, b) => (a.from < b.from ? -1 : a.from > b.from ? 1 : 0)))
const past = computed(() => rows.value.filter((r) => r.status === 'past' || r.status === 'cancelled'))

async function resolveId() {
  if (props.directoryId) return props.directoryId
  const key = normDriver(props.driverName)
  if (!key) return null
  const data = await api.get('/api/drivers-directory')
  const hit = (data.data || []).find((d) => normDriver(d.Driver) === key)
  resolvedId.value = hit ? hit._id : null
  return resolvedId.value
}

async function load() {
  loading.value = true
  error.value = ''
  try {
    const id = await resolveId()
    if (!id) { rows.value = []; error.value = 'This driver is not in the Drivers directory, so no time off can be recorded.'; return }
    const data = await api.get(`/api/drivers-directory/${id}/availability`)
    rows.value = data.rows || []
    today.value = data.today || ''
    if (!form.from) form.from = today.value
    if (!form.to) form.to = today.value
  } catch (err) {
    error.value = (err && err.message) || 'Time off could not be read.'
  } finally {
    loading.value = false
  }
}

async function run(fn) {
  busy.value = true
  error.value = ''
  try {
    await fn()
    await load()
    emit('changed')
    return true
  } catch (err) {
    error.value = (err && err.message) || 'The change could not be saved.'
    return false
  } finally {
    busy.value = false
  }
}

async function add() {
  const body = { kind: form.kind, from: form.from, to: form.to, reason: form.reason.trim() }
  const ok = await run(() => api.post(`/api/drivers-directory/${dirId.value}/availability`, body))
  if (ok) form.reason = ''
}

function startEnd(r) {
  endingId.value = r.id
  endTo.value = today.value && today.value >= r.from && today.value <= r.to ? today.value : r.from
}

async function saveEnd(r) {
  const ok = await run(() => api.put(`/api/driver-availability/${r.id}`, { to: endTo.value }))
  if (ok) endingId.value = null
}

async function confirmCancel() {
  const r = pendingCancel.value
  pendingCancel.value = null
  if (r) await run(() => api.post(`/api/driver-availability/${r.id}/cancel`, {}))
}

watch(() => [props.directoryId, props.driverName], () => {
  resolvedId.value = null
  form.from = ''
  form.to = ''
  endingId.value = null
  load()
}, { immediate: true })
</script>

<style scoped>
.avail { display: flex; flex-direction: column; gap: 0.6rem; padding-top: 0.75rem; margin-top: 0.75rem; border-top: 1px solid #f3f4f6; }
.avail-head { display: flex; align-items: center; justify-content: space-between; gap: 0.5rem; }
.avail-title { font-size: 0.8rem; font-weight: 700; text-transform: uppercase; letter-spacing: 0.04em; color: #4b5563; margin: 0; }
.avail-muted { font-size: 0.75rem; color: #9ca3af; }
.avail-error { font-size: 0.8rem; color: #b91c1c; background: #fef2f2; border: 1px solid #fecaca; border-radius: 6px; padding: 0.5rem 0.65rem; margin: 0; white-space: pre-line; }
.avail-list { list-style: none; margin: 0; padding: 0; display: flex; flex-direction: column; gap: 0.5rem; }
.avail-row { display: flex; flex-wrap: wrap; align-items: center; justify-content: space-between; gap: 0.5rem; padding: 0.55rem 0.65rem; border: 1px solid #e5e7eb; border-radius: 8px; }
.avail-row-past { justify-content: flex-start; opacity: 0.8; }
.avail-row-main { display: flex; flex-wrap: wrap; align-items: center; gap: 0.4rem; min-width: 0; }
.avail-range { font-weight: 600; font-size: 0.85rem; color: #111827; }
.avail-tag { font-size: 0.65rem; font-weight: 700; padding: 1px 8px; border-radius: 999px; }
.avail-tag-now { background: #eef2ff; color: #3730a3; }
.avail-tag-next { background: #f1f5f9; color: #475569; }
.avail-kind { font-size: 0.75rem; color: #4b5563; }
.avail-reason { font-size: 0.75rem; color: #6b7280; overflow-wrap: anywhere; }
.avail-end { display: flex; flex-wrap: wrap; align-items: flex-end; gap: 0.5rem; width: 100%; }
.avail-actions { display: flex; flex-wrap: wrap; gap: 0.4rem; }
.avail-actions .btn { padding: 0.35rem 0.75rem; font-size: 0.78rem; }
.avail-form { display: flex; flex-direction: column; gap: 0.5rem; }
.avail-grid { display: grid; grid-template-columns: 1fr; gap: 0.5rem; }
@media (min-width: 768px) { .avail-grid { grid-template-columns: 1fr 1fr; } }
.avail-label { display: flex; flex-direction: column; gap: 0.25rem; font-size: 0.72rem; font-weight: 600; color: #4b5563; min-width: 0; }
.avail-input { width: 100%; min-width: 0; padding: 0.45rem 0.55rem; border: 1px solid #d1d5db; border-radius: 6px; font-size: 0.85rem; font-family: inherit; background: #fff; }
.avail-hint { font-size: 0.68rem; font-weight: 400; color: #9ca3af; }
.avail-past summary { cursor: pointer; font-size: 0.75rem; color: #6b7280; margin-bottom: 0.4rem; }
</style>
