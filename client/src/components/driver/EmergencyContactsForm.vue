<template>
  <van-popup
    :show="show"
    position="bottom"
    round
    teleport="body"
    :close-on-click-overlay="false"
    :style="{ height: '92%' }"
  >
    <div class="ec-sheet" role="dialog" aria-modal="true" aria-labelledby="ec-title" data-testid="ec-form">
      <div class="ec-head">
        <div id="ec-title" class="ec-title">Emergency contacts</div>
        <button type="button" class="ec-close" aria-label="Close" data-testid="ec-close" :disabled="saving" @click="close">&times;</button>
      </div>

      <div class="ec-body">
        <p class="ec-intro">Add at least {{ MIN_CONTACTS }} people we can call if something happens to you on the road.</p>
        <p v-if="loading" class="ec-state">Loading&hellip;</p>
        <div v-else-if="loadError" class="ec-state" role="alert">
          <p class="ec-state-text">{{ loadError }}</p>
          <van-button round size="small" native-type="button" @click="load">Try again</van-button>
        </div>
        <template v-else>
          <section v-for="(row, i) in rows" :key="row.key" class="ec-card" data-testid="ec-row">
            <div class="ec-card-head">
              <span class="ec-card-title">Contact {{ i + 1 }}<span v-if="i === 0" class="ec-primary"> (primary)</span></span>
              <button v-if="rows.length > MIN_CONTACTS" type="button" class="ec-remove" @click="removeRow(i)">Remove</button>
            </div>
            <van-field
              v-model="row.name"
              :name="`ec-name-${i}`"
              label="Name"
              label-align="top"
              placeholder="Their full name"
              :maxlength="CONTACT_NAME_MAX"
              autocomplete="off"
              :error-message="fieldError(i, 'name')"
            />
            <van-field
              v-model="row.relationship"
              :name="`ec-relationship-${i}`"
              label="Relationship"
              label-align="top"
              placeholder="Spouse, parent, friend..."
              :maxlength="RELATIONSHIP_MAX"
              autocomplete="off"
              :error-message="fieldError(i, 'relationship')"
            />
            <div class="ec-chips" role="group" :aria-label="`Relationship suggestions for contact ${i + 1}`">
              <button
                v-for="s in RELATIONSHIP_SUGGESTIONS"
                :key="s"
                type="button"
                :class="['ec-chip', { 'ec-chip-on': row.relationship === s }]"
                @click="row.relationship = s"
              >{{ s }}</button>
            </div>
            <van-field
              v-model="row.phone"
              :name="`ec-phone-${i}`"
              label="Phone"
              label-align="top"
              type="tel"
              inputmode="tel"
              placeholder="(202) 555-0143"
              :maxlength="PHONE_RAW_MAX"
              autocomplete="off"
              :error-message="fieldError(i, 'phone')"
            />
          </section>
          <button v-if="rows.length < MAX_CONTACTS" type="button" class="ec-add" data-testid="ec-add" @click="addRow">+ Add another contact</button>
        </template>
      </div>

      <div class="ec-foot">
        <p v-if="formError" class="ec-error" role="alert" data-testid="ec-error">{{ formError }}</p>
        <van-button
          round
          block
          type="primary"
          native-type="button"
          data-testid="ec-save"
          :disabled="!ready"
          :loading="saving"
          loading-text="Saving..."
          @click="save"
        >Save contacts</van-button>
      </div>
    </div>
  </van-popup>
</template>

<script setup>
import { ref, computed, watch } from 'vue'
import { Popup as VanPopup, Field as VanField, Button as VanButton } from 'vant'
import { useApi } from '../../composables/useApi'
import { useToast } from '../../composables/useToast'
import { useDriverStore } from '../../stores/driver'
import {
  MIN_CONTACTS, MAX_CONTACTS, CONTACT_NAME_MAX, RELATIONSHIP_MAX, PHONE_RAW_MAX, RELATIONSHIP_SUGGESTIONS,
  CONTACTS_URL, blankRow, draftRows, listToSend, validateContactList, fieldOfRefusal, refusalText,
} from '../../lib/emergencyContacts'

const props = defineProps({
  show: { type: Boolean, default: false },
})
const emit = defineEmits(['close', 'saved'])

const api = useApi()
const driverStore = useDriverStore()
const { show: toast } = useToast()

// The list lives in this component only, never in the store or the browser's
// storage, so a shared phone never shows the previous driver's contacts: it is
// read on every open and dropped on every close.
const rows = ref([])
const loading = ref(false)
const loadError = ref('')
const saving = ref(false)
const formError = ref('')
const fieldErrors = ref({})
// Moved on by every open, close and read: an answer that arrives after one is dropped.
let loadSeq = 0
let rowKey = 0
const keyed = (row) => ({ ...row, key: ++rowKey })

function reset() {
  loadSeq++
  rows.value = []
  loading.value = false
  loadError.value = ''
  saving.value = false
  formError.value = ''
  fieldErrors.value = {}
}

async function load() {
  const seq = ++loadSeq
  loading.value = true
  loadError.value = ''
  try {
    const answer = await api.get(CONTACTS_URL)
    if (seq !== loadSeq) return
    rows.value = draftRows(answer && answer.contacts).map(keyed)
  } catch (err) {
    if (seq !== loadSeq) return
    loadError.value = refusalText(err, 'READ_FAILED')
  } finally {
    if (seq === loadSeq) loading.value = false
  }
}

watch(() => props.show, (open) => {
  reset()
  if (open) load()
}, { immediate: true })

const ready = computed(() => !loading.value && !loadError.value && rows.value.length > 0)

function fieldError(i, field) {
  return fieldErrors.value[`${i}:${field}`] || ''
}

function clearErrors() {
  formError.value = ''
  fieldErrors.value = {}
}

function addRow() {
  if (rows.value.length >= MAX_CONTACTS) return
  rows.value.push(keyed(blankRow()))
  clearErrors()
}

function removeRow(i) {
  if (rows.value.length <= MIN_CONTACTS) return
  rows.value.splice(i, 1)
  clearErrors()
}

// A refusal, the form's own or the server's: at the field of the entry it names and,
// with that contact's number, above Save where the driver is looking.
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
  if (!ready.value || saving.value) return
  clearErrors()
  const { body, rowOf } = listToSend(rows.value)
  const check = validateContactList(body)
  if (!check.ok) { showRefusal(check.code, check.index, rowOf, check.error); return }
  const seq = loadSeq
  saving.value = true
  try {
    await api.put(CONTACTS_URL, body)
    if (seq !== loadSeq) return
    toast('Emergency contacts saved', 'success')
    emit('saved')
    // The second contact can finish the onboarding signing step: read the payload again.
    try { await driverStore.loadData() } catch { /* the screen catches up on its next read */ }
    if (seq === loadSeq) emit('close')
  } catch (err) {
    if (seq !== loadSeq) return
    showRefusal(err && err.code, err && err.data ? err.data.index : undefined, rowOf, refusalText(err))
  } finally {
    if (seq === loadSeq) saving.value = false
  }
}

function close() {
  if (!saving.value) emit('close')
}
</script>

<style scoped>
/* The sheet is the popup's height (a share of the window, never vh: on a phone vh
   is taller than the visible area while the toolbars show), so Save stays on screen. */
.ec-sheet { height: 100%; display: flex; flex-direction: column; background: #fff; }
.ec-head {
  display: flex; align-items: center; justify-content: space-between;
  padding: 0.35rem 0.5rem 0.35rem 1rem; border-bottom: 1px solid #e8edf2; flex-shrink: 0;
}
.ec-title { font-weight: 800; font-size: 1.02rem; color: #0f172a; }
.ec-close {
  width: 44px; height: 44px; border: none; background: none; border-radius: 8px;
  font-size: 1.6rem; color: #6b7085; cursor: pointer;
}
.ec-close:disabled { opacity: 0.4; cursor: default; }
.ec-body { flex: 1; min-height: 0; overflow-y: auto; -webkit-overflow-scrolling: touch; padding: 0.75rem 0.75rem 1rem; }
.ec-intro { margin: 0 0.25rem 0.75rem; font-size: 0.85rem; color: #475569; line-height: 1.5; }
.ec-state { padding: 1.5rem 0.5rem; text-align: center; color: #64748b; font-size: 0.88rem; }
.ec-state-text { margin: 0 0 0.75rem; }
.ec-card { border: 1px solid #e2e8f0; border-radius: 12px; padding: 0.25rem 0 0.5rem; margin-bottom: 0.75rem; overflow: hidden; }
.ec-card-head { display: flex; align-items: center; justify-content: space-between; padding: 0.25rem 0.5rem 0 1rem; min-height: 40px; }
.ec-card-title { font-weight: 700; font-size: 0.85rem; color: #0f172a; }
.ec-primary { font-weight: 500; color: #64748b; }
.ec-remove {
  border: none; background: none; color: #b91c1c; font-size: 0.8rem; font-weight: 600;
  min-height: 40px; padding: 0 0.6rem; cursor: pointer;
}
.ec-chips { display: flex; gap: 0.4rem; overflow-x: auto; padding: 0.15rem 1rem 0.4rem; scrollbar-width: none; }
.ec-chips::-webkit-scrollbar { display: none; }
.ec-chip {
  flex-shrink: 0; border: 1px solid #cbd5e1; background: #f8fafc; color: #334155;
  border-radius: 99px; padding: 0.35rem 0.75rem; font-size: 0.75rem; cursor: pointer;
}
.ec-chip-on { border-color: #1d4ed8; background: #dbeafe; color: #1e3a8a; font-weight: 600; }
.ec-add {
  width: 100%; border: 1px dashed #94a3b8; background: #f8fafc; color: #0f2847;
  border-radius: 12px; padding: 0.8rem; font-weight: 700; font-size: 0.88rem; cursor: pointer;
}
.ec-foot {
  flex-shrink: 0; border-top: 1px solid #e8edf2; background: #fff;
  padding: 0.6rem 0.75rem calc(0.75rem + env(safe-area-inset-bottom, 0px));
}
.ec-error { margin: 0 0 0.5rem; font-size: 0.82rem; color: #b91c1c; line-height: 1.4; }
</style>
