<template>
  <!-- A receipt's Personal line (R3 v1): the pill, and for a Super Admin the
       Personal / Undo / Reverse buttons. Everything shown comes from the server
       (lib/personalReceipt.js); the browser computes no money. -->
  <span :class="['personal-actions', { 'personal-compact': compact }]" @click.stop @keydown.stop>
    <span v-if="pill" :class="['personal-pill', `personal-${expense.personal.state}`]" :title="pill">{{ compact ? shortPill : pill }}</span>
    <button v-if="showMark" type="button" class="btn-personal" :disabled="busy" @click="openDialog('mark')">Personal</button>
    <button v-if="showUndo" type="button" class="btn-personal-undo" :disabled="busy" @click="openDialog('undo')">Undo Personal</button>
    <button v-if="showReverse" type="button" class="btn-personal-undo" :disabled="busy" @click="openDialog('reverse')">Reverse Personal</button>

    <ConfirmModal
      :open="dialog === 'mark'"
      title="Mark this receipt Personal"
      :message="markDialogText"
      confirm-text="Mark Personal"
      :confirm-disabled="busy || !amount.trim()"
      @confirm="submit"
      @cancel="close"
    >
      <label class="personal-field">
        <span>Amount the driver repays ($)</span>
        <input v-model="amount" type="text" inputmode="decimal" maxlength="12" autocomplete="off" />
      </label>
      <label class="personal-field">
        <span>Reason (optional)</span>
        <input v-model="reason" type="text" maxlength="300" autocomplete="off" />
      </label>
    </ConfirmModal>

    <ConfirmModal
      :open="dialog === 'undo' || dialog === 'reverse'"
      :title="dialog === 'undo' ? 'Undo the Personal line' : 'Reverse the Personal line'"
      :message="dialog === 'undo'
        ? 'The line comes off the receipt and off its invoice, and the receipt is a company cost again.'
        : reverseDialogText"
      :confirm-text="dialog === 'undo' ? 'Undo Personal' : 'Reverse'"
      :confirm-disabled="busy"
      danger
      @confirm="submit"
      @cancel="close"
    >
      <label class="personal-field">
        <span>Reason (optional)</span>
        <input v-model="reason" type="text" maxlength="300" autocomplete="off" />
      </label>
    </ConfirmModal>
  </span>
</template>

<script setup>
import { computed, ref } from 'vue'
import { useApi } from '../../../composables/useApi'
import { useToast } from '../../../composables/useToast'
import { useAuthStore } from '../../../stores/auth'
import ConfirmModal from '../../shared/ConfirmModal.vue'
import {
  canMarkPersonal,
  canReversePersonal,
  canUndoPersonal,
  personalDefaultAmount,
  personalMarkDialogText,
  personalPillText,
  personalReverseDialogText,
  personalShortText,
} from '../../../lib/personalReceipt'

const props = defineProps({
  expense: { type: Object, required: true },
  // GET /api/expenses/all's personalEnabled: the server accepts new marks.
  enabled: { type: Boolean, default: false },
  // GET /api/expenses/all's personalReceiptWeek: a line takes its receipt's week.
  receiptWeek: { type: Boolean, default: false },
  // The Expenses table: the short tag (full sentence on hover) and table-sized buttons.
  compact: { type: Boolean, default: false },
})
// changed(personal | null): the server's summary after the write; the list
// reloads on expenses:changed as well.
const emit = defineEmits(['changed'])

const api = useApi()
const { show: toast } = useToast()
const auth = useAuthStore()

const dialog = ref('')
const amount = ref('')
const reason = ref('')
const busy = ref(false)

const who = computed(() => ({ isSuperAdmin: !!auth.isSuperAdmin, enabled: props.enabled }))
const showMark = computed(() => canMarkPersonal(props.expense, who.value))
const showUndo = computed(() => canUndoPersonal(props.expense, who.value))
const showReverse = computed(() => canReversePersonal(props.expense, who.value))
const pill = computed(() => personalPillText(props.expense.personal))
const shortPill = computed(() => personalShortText(props.expense.personal))
const markDialogText = computed(() => personalMarkDialogText(props.receiptWeek))
const reverseDialogText = computed(() => personalReverseDialogText(props.receiptWeek))

function openDialog(kind) {
  dialog.value = kind
  reason.value = ''
  amount.value = kind === 'mark' ? personalDefaultAmount(props.expense) : ''
}

function close() {
  if (!busy.value) dialog.value = ''
}

// Writes re-render an invoice PDF, so they get longer than the usual 20 s.
const WRITE_TIMEOUT_MS = 60000

async function submit() {
  if (busy.value) return
  const kind = dialog.value
  const id = props.expense.id
  busy.value = true
  try {
    if (kind === 'mark') {
      const res = await api.post(`/api/expenses/${id}/personal`, { amount: amount.value.trim(), reason: reason.value }, { timeout: WRITE_TIMEOUT_MS })
      emit('changed', res.personal || null)
      toast(res.alreadyMarked ? 'Already marked Personal' : 'Marked Personal', 'success')
    } else if (kind === 'undo') {
      await api.del(`/api/expenses/${id}/personal`, { body: JSON.stringify({ reason: reason.value }), timeout: WRITE_TIMEOUT_MS })
      emit('changed', null)
      toast('Personal line undone', 'success')
    } else if (kind === 'reverse') {
      const res = await api.post(`/api/expenses/${id}/personal/reverse`, { reason: reason.value }, { timeout: WRITE_TIMEOUT_MS })
      emit('changed', props.expense.personal ? { ...props.expense.personal, state: 'reversed' } : null)
      toast(res.reverse && res.reverse.invoice_number ? `Reversed on ${res.reverse.invoice_number}` : 'Personal line reversed', 'success')
    }
    dialog.value = ''
  } catch (err) {
    // The server's own sentence (amount, a finalized month, use Reverse, ...).
    toast((err && err.message) || 'The Personal change was not saved', 'error')
  } finally {
    busy.value = false
  }
}
</script>

<style scoped>
/* Never wider than its card or cell: a one-line pill pushed the Expenses list
   past the screen edge and made it scroll sideways. */
.personal-actions {
  display: flex;
  flex-wrap: wrap;
  align-items: center;
  gap: 0.35rem;
  min-width: 0;
  max-width: 100%;
}
/* break-word, not anywhere: it keeps whole words as the table column's minimum,
   so the cell isn't squeezed to a letter-wide strip. */
.personal-pill {
  display: inline-block;
  max-width: 100%;
  padding: 0.1rem 0.5rem;
  border-radius: 0.6rem;
  font-size: 0.72rem;
  font-weight: 600;
  line-height: 1.35;
  white-space: normal;
  overflow-wrap: break-word;
  background: #fef3c7;
  color: #92400e;
}
.personal-pill.personal-needs_correction { background: #fee2e2; color: #991b1b; }
.personal-pill.personal-carried { background: #e0e7ff; color: #3730a3; }
.personal-pill.personal-reversed { background: #e5e7eb; color: #374151; }
.btn-personal,
.btn-personal-undo {
  padding: 0.2rem 0.6rem;
  border-radius: 6px;
  font-size: 0.75rem;
  font-weight: 600;
  cursor: pointer;
  border: 1px solid #d97706;
  background: #fffbeb;
  color: #92400e;
}
.btn-personal-undo { border-color: #9ca3af; background: #fff; color: #374151; }
.btn-personal:disabled,
.btn-personal-undo:disabled { opacity: 0.5; cursor: default; }
/* The table's size, matching the row's Approve / Reject buttons. */
.personal-compact { gap: 0.25rem; }
.personal-compact .personal-pill { font-size: 0.68rem; }
.personal-compact .btn-personal,
.personal-compact .btn-personal-undo { padding: 0.22rem 0.55rem; font-size: 0.68rem; border-radius: 5px; }
.personal-field {
  display: flex;
  flex-direction: column;
  gap: 0.25rem;
  margin-top: 0.5rem;
  font-size: 0.8rem;
  text-align: left;
}
.personal-field input {
  padding: 0.4rem 0.5rem;
  border: 1px solid #d1d5db;
  border-radius: 6px;
  font-size: 0.9rem;
}
</style>
