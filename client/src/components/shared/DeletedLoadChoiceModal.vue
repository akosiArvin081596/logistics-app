<template>
  <!-- ConfirmModal, so this works over the rate-con dialog as every confirm does: Cancel first and focused. -->
  <ConfirmModal
    :open="open && !!choice"
    :title="view.title"
    :message="view.message"
    :confirm-text="confirmText"
    cancel-text="Cancel"
    :confirm-disabled="busy || !picked || !reasonReady"
    @confirm="onConfirm"
    @cancel="onCancel"
  >
    <p v-if="note" class="dlc-note" role="status">{{ note }}</p>
    <p v-if="view.why" class="dlc-why">{{ view.why }}</p>
    <div class="dlc-options" role="radiogroup" aria-label="What to do with this Load ID">
      <label class="dlc-option" :class="{ 'dlc-option-off': view.restoreOff }">
        <input v-model="picked" type="radio" :name="groupName" value="restore" :disabled="view.restoreOff || busy" />
        <span class="dlc-option-text">
          <span class="dlc-option-title">Restore the deleted load</span>
          <span class="dlc-option-note">{{ view.restoreNote }}</span>
          <span v-for="line in view.monthLines" :key="line" class="dlc-option-month">{{ line }}</span>
        </span>
      </label>
      <label class="dlc-option" :class="{ 'dlc-option-off': view.createOff }">
        <input v-model="picked" type="radio" :name="groupName" value="create_new" :disabled="view.createOff || busy" />
        <span class="dlc-option-text">
          <span class="dlc-option-title">Create it as new</span>
          <span class="dlc-option-note">{{ view.createNote }}</span>
        </span>
      </label>
    </div>
    <label class="dlc-reason">
      <span class="dlc-reason-label">Reason (recorded in the audit trail and sent to the Super Admins)</span>
      <textarea v-model="reason" class="dlc-reason-input" rows="2" :maxlength="RESTORE_REASON_MAX" :disabled="busy" placeholder="e.g. deleted by mistake; the broker confirmed the load"></textarea>
    </label>
    <p v-if="error" class="dlc-error" role="alert">{{ error }}</p>
  </ConfirmModal>
</template>

<script setup>
import { computed, ref, useId, watch } from 'vue'
import { useApi } from '../../composables/useApi'
import { fmtAppInstant } from '../../utils/datetime'
import { RESTORE_REASON_MAX, deletedLoadChoiceView, restoreErrorText, restoreReasonReady, restoreUrl } from '../../lib/deletedLoadsView.js'
import ConfirmModal from './ConfirmModal.vue'

// The server's choice for a Load ID an old delete names (its 409 LOAD_ID_DELETED,
// or a dashboard banner line). Restore always goes through the restore route;
// "Create it as new" goes back to the form to send again, or, with `review`, through the route.
// Either needs a reason of 3+ characters, sent with it (the 10-22 Restore decision).
const props = defineProps({
  open: { type: Boolean, default: false },
  choice: { type: Object, default: null },
  note: { type: String, default: '' },
  review: { type: Boolean, default: false },
})
const emit = defineEmits(['resolved', 'create-new', 'cancel'])

const api = useApi()
const groupName = `dlc-${useId()}`
const picked = ref('')
const reason = ref('')
const busy = ref(false)
const error = ref('')
const view = computed(() => deletedLoadChoiceView(props.choice, fmtAppInstant(props.choice?.deletedAt), { review: props.review }))
const reasonReady = computed(() => restoreReasonReady(reason.value))
const confirmText = computed(() => {
  if (picked.value === 'restore') return 'Restore the deleted load'
  if (picked.value === 'create_new') return 'Create it as new'
  return 'Choose one'
})

// Each question starts clear, with its one open choice picked when only one is open.
watch(() => [props.open, props.choice], ([isOpen]) => {
  if (!isOpen) return
  error.value = ''
  reason.value = ''
  const v = view.value
  picked.value = !v.restoreOff && v.createOff ? 'restore' : v.restoreOff && !v.createOff ? 'create_new' : ''
}, { immediate: true })

async function onConfirm() {
  if (busy.value || !picked.value || !props.choice || !reasonReady.value) return
  const why = reason.value.trim()
  if (picked.value === 'create_new' && !props.review) {
    emit('create-new', why)
    return
  }
  busy.value = true
  error.value = ''
  try {
    const answer = await api.post(restoreUrl(props.choice.tombstoneId), picked.value === 'create_new' ? { mode: 'create_new', reason: why } : { reason: why })
    emit('resolved', answer)
  } catch (err) {
    error.value = restoreErrorText(err)
  } finally {
    busy.value = false
  }
}

// A restore in flight is waited for; its answer decides what happens next.
function onCancel() {
  if (!busy.value) emit('cancel')
}
</script>

<style scoped>
.dlc-note {
  margin: 0 0 0.75rem;
  padding: 0.5rem 0.65rem;
  border-radius: 6px;
  background: #fffbeb;
  border: 1px solid #fde68a;
  color: #92400e;
  font-size: 0.8rem;
}
.dlc-why {
  margin: 0 0 0.75rem;
  font-size: 0.8rem;
  color: var(--text-dim);
}
.dlc-options {
  display: flex;
  flex-direction: column;
  gap: 0.5rem;
}
.dlc-option {
  display: flex;
  align-items: flex-start;
  gap: 0.6rem;
  padding: 0.6rem 0.7rem;
  border: 1px solid var(--border);
  border-radius: 8px;
  cursor: pointer;
}
.dlc-option input { margin-top: 0.2rem; flex-shrink: 0; }
.dlc-option-off { cursor: not-allowed; background: var(--bg); }
.dlc-option-off .dlc-option-title { color: var(--text-dim); }
.dlc-option-text { display: flex; flex-direction: column; gap: 0.15rem; min-width: 0; }
.dlc-option-title { font-size: 0.85rem; font-weight: 600; color: var(--text); }
.dlc-option-note { font-size: 0.78rem; color: var(--text-dim); overflow-wrap: anywhere; }
.dlc-option-month { font-size: 0.78rem; color: var(--text); overflow-wrap: anywhere; }
.dlc-reason {
  display: flex;
  flex-direction: column;
  gap: 0.3rem;
  margin-top: 0.75rem;
}
.dlc-reason-label { font-size: 0.8rem; font-weight: 600; color: var(--text); }
.dlc-reason-input {
  display: block;
  width: 100%;
  padding: 0.5rem 0.6rem;
  font-size: 0.85rem;
  font-family: inherit;
  border: 1px solid var(--border, #e2e8f0);
  border-radius: 8px;
  background: var(--bg, #fff);
  color: inherit;
  resize: vertical;
  box-sizing: border-box;
}
.dlc-reason-input:focus { outline: none; border-color: #94a3b8; }
.dlc-error {
  margin: 0.75rem 0 0;
  font-size: 0.8rem;
  color: #b91c1c;
}
</style>
