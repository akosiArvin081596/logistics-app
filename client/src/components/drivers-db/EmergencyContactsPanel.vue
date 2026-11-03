<template>
  <!-- A driver's emergency contacts on the office screens (the Drivers page detail
       and the dashboard's Fleet & Drivers dialog): list, tap to call, edit. The
       server decides who may see them (Super Admin and Dispatcher) and answers
       404 FEATURE_OFF while EMERGENCY_CONTACTS_ENABLED is off; until it answers,
       and after that answer, nothing is shown. -->
  <section v-if="!hidden" class="ecp" aria-label="Emergency contacts" data-testid="ec-panel">
    <div class="ecp-head">
      <h4 class="ecp-title">Emergency contacts</h4>
      <span v-if="loading" class="ecp-muted">Loading…</span>
      <button v-else-if="linked && !editing" type="button" class="btn btn-secondary ecp-small" data-testid="ec-panel-edit" @click="openEdit">Edit</button>
    </div>

    <p v-if="error" class="ecp-error" role="alert" data-testid="ec-panel-error">{{ error }}</p>
    <p v-else-if="unlinked" class="ecp-muted" data-testid="ec-panel-unlinked">{{ unlinked }}</p>
    <template v-else-if="linked">
      <form v-if="editing" class="ecp-form" data-testid="ec-panel-form" @submit.prevent="save">
        <fieldset v-for="(row, i) in rows" :key="row.key" class="ecp-row" data-testid="ec-panel-row">
          <legend class="ecp-legend">Contact {{ i + 1 }}<span v-if="i === 0" class="ecp-muted"> (primary)</span></legend>
          <div class="ecp-grid">
            <label class="ecp-label">
              Name
              <input v-model="row.name" :name="`ecp-name-${i}`" type="text" class="ecp-input" :maxlength="CONTACT_NAME_MAX" autocomplete="off" />
              <span v-if="fieldError(i, 'name')" class="ecp-field-error">{{ fieldError(i, 'name') }}</span>
            </label>
            <label class="ecp-label">
              Relationship
              <input v-model="row.relationship" :name="`ecp-relationship-${i}`" type="text" class="ecp-input" :maxlength="RELATIONSHIP_MAX" :list="suggestionsId" autocomplete="off" />
              <span v-if="fieldError(i, 'relationship')" class="ecp-field-error">{{ fieldError(i, 'relationship') }}</span>
            </label>
            <label class="ecp-label">
              Phone
              <input
                v-model="row.phone"
                :name="`ecp-phone-${i}`"
                type="tel"
                inputmode="tel"
                class="ecp-input"
                placeholder="(202) 555-0143"
                :maxlength="PHONE_RAW_MAX"
                autocomplete="off"
              />
              <span v-if="fieldError(i, 'phone')" class="ecp-field-error">{{ fieldError(i, 'phone') }}</span>
            </label>
          </div>
          <button v-if="rows.length > MIN_CONTACTS" type="button" class="ecp-remove" :disabled="saving" @click="removeRow(i)">Remove</button>
        </fieldset>
        <datalist :id="suggestionsId">
          <option v-for="s in RELATIONSHIP_SUGGESTIONS" :key="s" :value="s" />
        </datalist>
        <button v-if="rows.length < MAX_CONTACTS" type="button" class="ecp-add" :disabled="saving" @click="addRow">+ Add another contact</button>
        <p v-if="formError" class="ecp-error" role="alert" data-testid="ec-panel-form-error">{{ formError }}</p>
        <div class="ecp-actions">
          <button type="button" class="btn btn-secondary ecp-small" :disabled="saving" @click="closeEdit">Back</button>
          <button type="submit" class="btn btn-primary ecp-small" data-testid="ec-panel-save" :disabled="saving">{{ saving ? 'Saving…' : 'Save contacts' }}</button>
        </div>
      </form>
      <ul v-else-if="lines.length" class="ecp-list">
        <li v-for="line in lines" :key="line.id ?? line.phone" class="ecp-item" data-testid="ec-panel-line">
          <span class="ecp-who">
            <span class="ecp-name">{{ line.name }}</span>
            <span v-if="line.primary" class="ecp-tag">Primary</span>
            <span class="ecp-rel">{{ line.relationship }}</span>
          </span>
          <a v-if="line.tel" :href="line.tel" class="ecp-phone">{{ line.phone }}</a>
          <span v-else class="ecp-phone">{{ line.phone }}</span>
        </li>
      </ul>
      <p v-else class="ecp-muted" data-testid="ec-panel-empty">No emergency contacts on file yet.</p>
      <p v-if="!editing && lines.length && lines.length < MIN_CONTACTS" class="ecp-muted">The driver needs at least {{ MIN_CONTACTS }}.</p>
    </template>
  </section>
</template>

<script>
// One memo for the page load: <script setup> runs again for every panel, and both screens
// mount a new panel on each open. Once the server says the feature is off, no panel asks
// again until the next page load.
let featureOffSeen = false
</script>

<script setup>
import { computed, onUnmounted, ref, useId, watch } from 'vue'
import { useApi } from '../../composables/useApi'
import { normDriver } from '../../lib/driverName'
import { replyLost } from '../../lib/saveOutcome'
import {
  MIN_CONTACTS, MAX_CONTACTS, CONTACT_NAME_MAX, RELATIONSHIP_MAX, PHONE_RAW_MAX, RELATIONSHIP_SUGGESTIONS,
  adoptStoredIds, blankRow, contactLines, draftRows, fieldOfRefusal, isFeatureOff, linkedText, listToSend,
  staffContactsUrl, staffRefusalText, validateContactList,
} from '../../lib/emergencyContacts'

// `directoryId` when the caller has it (the Drivers page); otherwise the driver is
// found in the directory by name (the dashboard's Fleet & Drivers).
const props = defineProps({
  directoryId: { type: Number, default: null },
  driverName: { type: String, default: '' },
})

const api = useApi()
const suggestionsId = useId()
const hidden = ref(true)
const loading = ref(false)
const error = ref('')
const linked = ref(false)
const unlinked = ref('')
// The list lives in this panel only, never the browser's storage.
const stored = ref([])
const editing = ref(false)
const rows = ref([])
const saving = ref(false)
const formError = ref('')
const fieldErrors = ref({})
const dirId = ref(null)
// Moved on by every driver change and by unmounting: a late answer is dropped.
let seq = 0
// Set when a save got no answer: it may be stored, so the next Save reads the list first.
let idsStale = false
let rowKey = 0
const keyed = (row) => ({ ...row, key: ++rowKey })

const lines = computed(() => contactLines(stored.value))

function clearForm() {
  editing.value = false
  rows.value = []
  formError.value = ''
  fieldErrors.value = {}
  idsStale = false
}

function apply(answer) {
  linked.value = !!(answer && answer.linked === true)
  unlinked.value = linked.value ? '' : linkedText(answer && answer.reason)
  stored.value = linked.value && Array.isArray(answer.contacts) ? answer.contacts : []
}

async function resolveId() {
  if (props.directoryId) return props.directoryId
  const key = normDriver(props.driverName)
  if (!key) return null
  const data = await api.get('/api/drivers-directory')
  const hit = (data && Array.isArray(data.data) ? data.data : []).find((d) => normDriver(d.Driver) === key)
  return hit && Number.isSafeInteger(hit._id) ? hit._id : null
}

async function load() {
  const mine = ++seq
  hidden.value = true
  error.value = ''
  linked.value = false
  unlinked.value = ''
  stored.value = []
  dirId.value = null
  clearForm()
  if (featureOffSeen) return
  let id = null
  try {
    id = await resolveId()
  } catch {
    id = null
  }
  const url = staffContactsUrl(id)
  // A driver not found in the directory has nothing to show here.
  if (mine !== seq || !url) return
  loading.value = true
  try {
    const answer = await api.get(url)
    if (mine !== seq) return
    dirId.value = id
    apply(answer)
    hidden.value = false
  } catch (err) {
    if (mine !== seq) return
    if (isFeatureOff(err)) {
      featureOffSeen = true
      return
    }
    error.value = staffRefusalText(err, 'READ_FAILED')
    hidden.value = false
  } finally {
    if (mine === seq) loading.value = false
  }
}

function openEdit() {
  rows.value = draftRows(stored.value).map(keyed)
  formError.value = ''
  fieldErrors.value = {}
  editing.value = true
}

function closeEdit() {
  if (!saving.value) clearForm()
}

function fieldError(i, field) {
  return fieldErrors.value[`${i}:${field}`] || ''
}

function addRow() {
  if (rows.value.length >= MAX_CONTACTS) return
  rows.value.push(keyed(blankRow()))
  formError.value = ''
  fieldErrors.value = {}
}

function removeRow(i) {
  if (rows.value.length <= MIN_CONTACTS) return
  rows.value.splice(i, 1)
  formError.value = ''
  fieldErrors.value = {}
}

// A refusal, the panel's own or the server's: at the field of the entry it names
// and, with that contact's number, above Save.
function showRefusal(code, index, rowOf, text) {
  const field = fieldOfRefusal(code)
  const row = Number.isInteger(index) ? rowOf[index] : undefined
  if (field && row !== undefined) {
    fieldErrors.value = { [`${row}:${field}`]: text }
    formError.value = `Contact ${row + 1}: ${text}`
  } else {
    formError.value = text
  }
}

async function save() {
  const url = staffContactsUrl(dirId.value)
  if (saving.value || !url) return
  const mine = seq
  formError.value = ''
  fieldErrors.value = {}
  saving.value = true
  let rowOf = []
  try {
    // After a lost answer, the stored ids taken back first (adoptStoredIds()), so this
    // Save never deletes and re-adds what the lost one stored.
    if (idsStale) {
      const fresh = await api.get(url)
      if (mine !== seq) return
      rows.value = adoptStoredIds(rows.value, fresh && fresh.contacts)
      idsStale = false
    }
    const sent = listToSend(rows.value)
    rowOf = sent.rowOf
    const check = validateContactList(sent.body)
    if (!check.ok) { showRefusal(check.code, check.index, rowOf, check.error); return }
    const body = sent.body
    const answer = await api.put(url, body)
    if (mine !== seq) return
    apply(answer)
    clearForm()
  } catch (err) {
    if (mine !== seq) return
    if (replyLost(err)) idsStale = true
    showRefusal(err && err.code, err && err.data ? err.data.index : undefined, rowOf, staffRefusalText(err))
  } finally {
    if (mine === seq) saving.value = false
  }
}

watch(() => [props.directoryId, props.driverName], load, { immediate: true })
onUnmounted(() => { seq++; stored.value = []; rows.value = [] })
</script>

<style scoped>
.ecp { display: flex; flex-direction: column; gap: 0.6rem; padding-top: 0.75rem; margin-top: 0.75rem; border-top: 1px solid #f3f4f6; }
.ecp-head { display: flex; align-items: center; justify-content: space-between; gap: 0.5rem; }
.ecp-title { font-size: 0.8rem; font-weight: 700; text-transform: uppercase; letter-spacing: 0.04em; color: #4b5563; margin: 0; }
.ecp-muted { font-size: 0.75rem; color: #6b7280; margin: 0; }
.ecp-error { font-size: 0.8rem; color: #b91c1c; background: #fef2f2; border: 1px solid #fecaca; border-radius: 6px; padding: 0.5rem 0.65rem; margin: 0; }
.ecp-small { padding: 0.35rem 0.75rem; font-size: 0.78rem; }
.ecp-list { list-style: none; margin: 0; padding: 0; display: flex; flex-direction: column; gap: 0.5rem; }
.ecp-item { display: flex; flex-wrap: wrap; align-items: center; justify-content: space-between; gap: 0.35rem 0.75rem; padding: 0.55rem 0.65rem; border: 1px solid #e5e7eb; border-radius: 8px; min-width: 0; }
.ecp-who { display: flex; flex-wrap: wrap; align-items: baseline; gap: 0.25rem 0.5rem; min-width: 0; }
.ecp-name { font-weight: 600; font-size: 0.85rem; color: #111827; overflow-wrap: anywhere; }
.ecp-tag { font-size: 0.65rem; font-weight: 700; padding: 1px 8px; border-radius: 999px; background: #eef2ff; color: #3730a3; }
.ecp-rel { font-size: 0.75rem; color: #4b5563; overflow-wrap: anywhere; }
.ecp-phone { font-size: 0.85rem; font-weight: 600; color: #0369a1; text-decoration: none; white-space: nowrap; min-height: 32px; display: inline-flex; align-items: center; }
.ecp-form { display: flex; flex-direction: column; gap: 0.6rem; }
.ecp-row { border: 1px solid #e5e7eb; border-radius: 8px; padding: 0.5rem 0.65rem 0.6rem; margin: 0; min-width: 0; }
.ecp-legend { font-size: 0.75rem; font-weight: 700; color: #111827; padding: 0 0.25rem; }
.ecp-grid { display: grid; grid-template-columns: 1fr; gap: 0.5rem; }
@media (min-width: 768px) { .ecp-grid { grid-template-columns: 1fr 1fr; } }
.ecp-label { display: flex; flex-direction: column; gap: 0.25rem; font-size: 0.72rem; font-weight: 600; color: #4b5563; min-width: 0; }
.ecp-input { width: 100%; min-width: 0; padding: 0.45rem 0.55rem; border: 1px solid #d1d5db; border-radius: 6px; font-size: 0.85rem; font-family: inherit; background: #fff; }
.ecp-field-error { font-size: 0.7rem; font-weight: 500; color: #b91c1c; }
.ecp-remove { margin-top: 0.4rem; border: none; background: none; color: #b91c1c; font-size: 0.75rem; font-weight: 600; cursor: pointer; padding: 0.25rem 0; }
.ecp-add { border: 1px dashed #94a3b8; background: #f8fafc; color: #0f2847; border-radius: 8px; padding: 0.55rem; font-weight: 700; font-size: 0.8rem; cursor: pointer; }
.ecp-actions { display: flex; flex-wrap: wrap; justify-content: flex-end; gap: 0.4rem; }
</style>
