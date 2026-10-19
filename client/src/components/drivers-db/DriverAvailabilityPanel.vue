<template>
  <!-- A driver's recorded time off (R11): list, add, edit, end early, cancel.
       The server owns every rule (dates, the 60-day cap, a Dispatcher's 30-day
       and end-early limits, overlaps). It says per row what the caller may
       change (`editable`: "full" / "end_early" / "none") and between which days
       (`limits`, with the range cap `maxDays`), and for the add form
       (`createLimits`, which also names the Dispatcher's back-dating window);
       this shows exactly those buttons and days, sends only the fields that
       changed, and shows the server's words when it refuses. Over loads he
       already has (R11b, when the server's loads warning is on) the server
       asks first, in its own words: "Keep as is" writes nothing, "Save anyway"
       re-sends with the server's list of loads echoed back. Rendered only by
       screens whose data says availability is on. -->
  <section ref="panelEl" class="avail" aria-label="Time off">
    <!-- One row's buttons and its inline edit form, shared by the live and the
         past lists. -->
    <DefineRowEdit v-slot="{ r }">
      <form v-if="editingId === r.id && editBounds" class="avail-edit" @submit.prevent="saveEdit(r)" @keydown.esc.prevent="closeEdit(r.id)">
        <div v-if="rowActions(r).edit" class="avail-grid">
          <label class="avail-label">
            Kind
            <select v-model="editForm.kind" class="avail-input" data-avail-first>
              <option v-for="k in AVAILABILITY_KINDS" :key="k.value" :value="k.value">{{ k.label }}</option>
            </select>
          </label>
          <label class="avail-label">
            First day off
            <input v-model="editForm.from" type="date" class="avail-input" :min="editBounds.fromMin || undefined" required />
          </label>
          <label class="avail-label">
            Last day off
            <input v-model="editForm.to" type="date" class="avail-input" :min="editBounds.toMin || undefined" :max="editBounds.toMax || undefined" required />
          </label>
          <label class="avail-label">
            Reason (optional)
            <input v-model="editForm.reason" type="text" maxlength="200" class="avail-input" autocomplete="off" />
            <span class="avail-hint">Type of leave only (for example vacation or family). No medical details.</span>
          </label>
        </div>
        <template v-else>
          <p class="avail-note">{{ endEarlyNote(createLimits) }}</p>
          <label class="avail-label avail-label-end">
            Last day off
            <input v-model="editForm.to" type="date" class="avail-input" :min="editBounds.toMin || undefined" :max="editBounds.toMax || undefined" required data-avail-first />
          </label>
        </template>
        <p v-if="editHint" class="avail-note" role="status">{{ editHint }}</p>
        <div class="avail-actions">
          <button type="button" class="btn btn-secondary" :disabled="busy" @click="closeEdit(r.id)">Back</button>
          <button type="submit" class="btn btn-primary" :disabled="busy || !canSave">Save</button>
        </div>
      </form>
      <div v-else-if="rowActions(r).edit || rowActions(r).endEarly" class="avail-actions">
        <button v-if="rowActions(r).edit" type="button" class="btn btn-secondary" :disabled="busy" :data-avail-open="r.id" @click="openEdit(r)">Edit</button>
        <button v-if="rowActions(r).endEarly" type="button" class="btn btn-secondary" :disabled="busy" :data-avail-open="r.id" @click="openEdit(r)">End early</button>
        <button v-if="rowActions(r).cancel" type="button" class="btn btn-secondary" :disabled="busy" @click="pendingCancel = r">Cancel</button>
      </div>
    </DefineRowEdit>

    <div class="avail-head">
      <h4 ref="titleEl" class="avail-title" tabindex="-1">Time off</h4>
      <span v-if="loading" class="avail-muted">Loading…</span>
    </div>
    <p v-if="error" class="avail-error" role="alert">{{ error }}</p>
    <p v-if="notice" class="avail-note" role="status">{{ notice }}</p>

    <ul v-if="live.length" class="avail-list">
      <li v-for="r in live" :key="r.id" class="avail-row">
        <div class="avail-row-main">
          <span class="avail-range">{{ availabilityRangeText(r.from, r.to) }}</span>
          <span :class="['avail-tag', r.status === 'current' ? 'avail-tag-now' : 'avail-tag-next']">{{ r.status === 'current' ? 'Off now' : 'Upcoming' }}</span>
          <span class="avail-kind">{{ kindLabel(r.kind) }}</span>
          <span v-if="r.reason" class="avail-reason">{{ r.reason }}</span>
        </div>
        <ReuseRowEdit :r="r" />
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
          <input v-model="form.from" type="date" class="avail-input" :min="createBounds.fromMin || undefined" required />
        </label>
        <label class="avail-label">
          Last day off
          <input v-model="form.to" type="date" class="avail-input" :min="createBounds.toMin || undefined" :max="createBounds.toMax || undefined" required />
        </label>
        <label class="avail-label">
          Reason (optional)
          <input v-model="form.reason" type="text" maxlength="200" class="avail-input" autocomplete="off" />
          <span class="avail-hint">Type of leave only (for example vacation or family). No medical details.</span>
        </label>
      </div>
      <p v-if="addHint" class="avail-note" role="status">{{ addHint }}</p>
      <div class="avail-actions">
        <button type="submit" class="btn btn-primary" :disabled="busy || !dirId || !datesWithinBounds(form, createBounds)">Add time off</button>
      </div>
    </form>

    <details v-if="past.length" class="avail-past">
      <summary>Past and cancelled ({{ past.length }})</summary>
      <ul class="avail-list">
        <li v-for="r in past" :key="r.id" class="avail-row avail-row-past">
          <div class="avail-row-main">
            <span class="avail-range">{{ availabilityRangeText(r.from, r.to) }}</span>
            <span class="avail-kind">{{ kindLabel(r.kind) }}</span>
            <span class="avail-muted">{{ r.status === 'cancelled' ? 'Cancelled' : 'Ended' }}</span>
          </div>
          <ReuseRowEdit :r="r" />
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
    <ConfirmModal
      :open="!!pendingLoads"
      title="He has loads on these days"
      :message="pendingLoads ? pendingLoads.message : ''"
      confirm-text="Save anyway"
      cancel-text="Keep as is"
      @confirm="saveAnyway"
      @cancel="pendingLoads = null"
    />
  </section>
</template>

<script setup>
import { computed, nextTick, reactive, ref, watch } from 'vue'
import { createReusableTemplate } from '@vueuse/core'
import { useApi } from '../../composables/useApi'
import { normDriver } from '../../lib/driverName'
import {
  AVAILABILITY_KINDS, availabilityRangeText, canSaveEdit, createDateBounds, datesWithinBounds,
  editDateBounds, editFormFor, editPatch, endEarlyNote, isDriverHasLoadsWarning, kindLabel,
  loadsUncheckedNote, rangeHint, rowActions, withLoadsConfirmed,
} from '../../lib/availabilityText'
import ConfirmModal from '../shared/ConfirmModal.vue'

// `directoryId` when the caller has it (the Drivers page); otherwise the
// driver is found in the directory by name (the dashboard's Fleet & Drivers).
const props = defineProps({
  directoryId: { type: Number, default: null },
  driverName: { type: String, default: '' },
})
const emit = defineEmits(['changed'])
const api = useApi()
const [DefineRowEdit, ReuseRowEdit] = createReusableTemplate({ props: { r: { type: Object, required: true } } })

const panelEl = ref(null)
const titleEl = ref(null)
const resolvedId = ref(null)
const dirId = computed(() => props.directoryId || resolvedId.value)
const rows = ref([])
const today = ref('')
const createLimits = ref(null)
const loading = ref(false)
const busy = ref(false)
const error = ref('')
const form = reactive({ kind: 'vacation', from: '', to: '', reason: '' })
const editingId = ref(null)
const editForm = reactive({ kind: '', from: '', to: '', reason: '' })
const pendingCancel = ref(null)
// The server's loads warning on a save: { message, resend } ("Save anyway").
const pendingLoads = ref(null)
const notice = ref('')

const live = computed(() => rows.value.filter((r) => r.status === 'current' || r.status === 'upcoming')
  .slice().sort((a, b) => (a.from < b.from ? -1 : a.from > b.from ? 1 : 0)))
const past = computed(() => rows.value.filter((r) => r.status === 'past' || r.status === 'cancelled'))
const createBounds = computed(() => createDateBounds(createLimits.value, form))
const editingRow = computed(() => rows.value.find((r) => r.id === editingId.value) || null)
const editBounds = computed(() => (editingRow.value ? editDateBounds(editingRow.value, editForm) : null))
const canSave = computed(() => !!editingRow.value && canSaveEdit(editingRow.value, editForm))
const editHint = computed(() => (editBounds.value ? rangeHint(editForm, editBounds.value) : ''))
const addHint = computed(() => rangeHint(form, createBounds.value))

// A reload that leaves the open form's row gone or no longer editable closes it.
watch(editingRow, (r) => {
  if (editingId.value !== null && (!r || (!rowActions(r).edit && !rowActions(r).endEarly))) editingId.value = null
})

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
    createLimits.value = data.createLimits || null
    if (!form.from) form.from = today.value
    if (!form.to) form.to = today.value
  } catch (err) {
    error.value = (err && err.message) || 'Time off could not be read.'
  } finally {
    loading.value = false
  }
}

// `onLoadsWarning`, when given, takes the server's 409 DRIVER_HAS_LOADS instead
// of the alert box.
async function run(fn, onLoadsWarning) {
  busy.value = true
  error.value = ''
  notice.value = ''
  try {
    const reply = await fn()
    notice.value = loadsUncheckedNote(reply)
    await load()
    emit('changed')
    return true
  } catch (err) {
    if (onLoadsWarning && isDriverHasLoadsWarning(err)) onLoadsWarning(err)
    else error.value = (err && err.message) || 'The change could not be saved.'
    return false
  } finally {
    busy.value = false
  }
}

// A create or an edit. Over loads he already has the server asks first, in its
// own words; "Save anyway" re-sends the same body with the server's list echoed
// back, and a second warning asks again with the new list. `done` runs once the
// save went through.
async function save(send, body, done) {
  const ok = await run(() => send(body), (err) => {
    pendingLoads.value = { message: err.message, resend: () => save(send, withLoadsConfirmed(body, err.data), done) }
  })
  if (ok && done) done()
}

function saveAnyway() {
  const pending = pendingLoads.value
  pendingLoads.value = null
  if (pending) pending.resend()
}

async function add() {
  if (!datesWithinBounds(form, createBounds.value)) return
  const body = { kind: form.kind, from: form.from, to: form.to, reason: form.reason.trim() }
  const url = `/api/drivers-directory/${dirId.value}/availability`
  await save((b) => api.post(url, b), body, () => { form.reason = '' })
}

// Focus moves into the form when it opens and back to the row's button when it
// closes (to the panel's title when that row's button is gone or hidden).
async function focusPanel(selector) {
  await nextTick()
  const el = panelEl.value ? panelEl.value.querySelector(selector) : null
  if (el) el.focus()
  return !!el && document.activeElement === el
}

function openEdit(r) {
  Object.assign(editForm, editFormFor(r, today.value))
  editingId.value = r.id
  focusPanel('[data-avail-first]')
}

async function closeEdit(id) {
  editingId.value = null
  const back = await focusPanel(`[data-avail-open="${Number(id)}"]`)
  if (!back && titleEl.value) titleEl.value.focus()
}

async function saveEdit(r) {
  if (!canSaveEdit(r, editForm)) return
  await save((b) => api.put(`/api/driver-availability/${r.id}`, b), editPatch(r, editForm), () => closeEdit(r.id))
}

async function confirmCancel() {
  const r = pendingCancel.value
  pendingCancel.value = null
  if (r && rowActions(r).cancel) await run(() => api.post(`/api/driver-availability/${r.id}/cancel`, {}))
}

watch(() => [props.directoryId, props.driverName], () => {
  resolvedId.value = null
  form.from = ''
  form.to = ''
  editingId.value = null
  createLimits.value = null
  pendingLoads.value = null
  notice.value = ''
  load()
}, { immediate: true })
</script>

<style scoped>
.avail { display: flex; flex-direction: column; gap: 0.6rem; padding-top: 0.75rem; margin-top: 0.75rem; border-top: 1px solid #f3f4f6; }
.avail-head { display: flex; align-items: center; justify-content: space-between; gap: 0.5rem; }
.avail-title { font-size: 0.8rem; font-weight: 700; text-transform: uppercase; letter-spacing: 0.04em; color: #4b5563; margin: 0; }
.avail-title:focus { outline: none; }
.avail-muted { font-size: 0.75rem; color: #9ca3af; }
.avail-error { font-size: 0.8rem; color: #b91c1c; background: #fef2f2; border: 1px solid #fecaca; border-radius: 6px; padding: 0.5rem 0.65rem; margin: 0; white-space: pre-line; }
.avail-list { list-style: none; margin: 0; padding: 0; display: flex; flex-direction: column; gap: 0.5rem; }
.avail-row { display: flex; flex-wrap: wrap; align-items: center; justify-content: space-between; gap: 0.5rem; padding: 0.55rem 0.65rem; border: 1px solid #e5e7eb; border-radius: 8px; }
.avail-row-past .avail-row-main { opacity: 0.8; }
.avail-row-main { display: flex; flex-wrap: wrap; align-items: center; gap: 0.4rem; min-width: 0; }
.avail-range { font-weight: 600; font-size: 0.85rem; color: #111827; }
.avail-tag { font-size: 0.65rem; font-weight: 700; padding: 1px 8px; border-radius: 999px; }
.avail-tag-now { background: #eef2ff; color: #3730a3; }
.avail-tag-next { background: #f1f5f9; color: #475569; }
.avail-kind { font-size: 0.75rem; color: #4b5563; }
.avail-reason { font-size: 0.75rem; color: #6b7280; overflow-wrap: anywhere; }
.avail-edit { display: flex; flex-direction: column; gap: 0.5rem; width: 100%; padding-top: 0.5rem; border-top: 1px dashed #e5e7eb; }
.avail-note { font-size: 0.72rem; color: #6b7280; margin: 0; }
.avail-label-end { max-width: 16rem; }
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
