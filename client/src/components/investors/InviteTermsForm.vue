<template>
  <form class="itf" novalidate @submit.prevent="submit">
    <template v-if="readOnly">
      <p class="itf-msg itf-msg-note" role="status" data-test="invite-read-only">{{ readOnlyText }}</p>
      <dl class="itf-who">
        <div><dt>Invitee</dt><dd>{{ invite.inviteeName || '—' }}</dd></div>
        <div><dt>Email</dt><dd>{{ invite.inviteeEmail || '—' }}</dd></div>
      </dl>
      <PaymentTermsSummary :display="invite.display" :terms="invite.paymentTerms" :is-default="invite.isStandard" />
    </template>

    <template v-else>
      <div class="form-row">
        <div class="form-group">
          <label class="form-label" :for="ids.name">Invitee name *</label>
          <input
            :id="ids.name"
            ref="nameRef"
            v-model="form.name"
            class="form-input"
            data-test="invite-name"
            type="text"
            autocomplete="off"
            autofocus
            :maxlength="LIMITS.NAME_MAX"
            :aria-invalid="!!errors.name"
            :aria-describedby="errors.name ? ids.nameError : undefined"
          />
          <p v-if="errors.name" :id="ids.nameError" class="field-error">{{ errors.name }}</p>
        </div>
        <div class="form-group">
          <label class="form-label" :for="ids.email">Invitee email</label>
          <input
            :id="ids.email"
            ref="emailRef"
            v-model="form.email"
            class="form-input"
            data-test="invite-email"
            type="email"
            autocomplete="off"
            :aria-invalid="!!errors.email"
            :aria-describedby="errors.email ? ids.emailError : undefined"
          />
          <p v-if="errors.email" :id="ids.emailError" class="field-error">{{ errors.email }}</p>
        </div>
      </div>

      <fieldset class="itf-types" :aria-describedby="errors.type ? ids.typeError : undefined">
        <legend class="form-label">Payment terms</legend>
        <label class="itf-type" :class="{ 'is-selected': form.type === 'split' }">
          <input ref="typeRef" v-model="form.type" type="radio" value="split" :name="ids.type" data-test="invite-type-split" />
          <span>
            <strong>50/50 profit split</strong>
            <small>The standard contract. Any additional terms are added as Amendment No. 1.</small>
          </span>
        </label>
        <label class="itf-type" :class="{ 'is-selected': form.type === 'lease' }">
          <input v-model="form.type" type="radio" value="lease" :name="ids.type" data-test="invite-type-lease" />
          <span>
            <strong>Fixed monthly lease payment</strong>
            <small>A set amount each month in place of the 50/50 split.</small>
          </span>
        </label>
      </fieldset>
      <p v-if="errors.type" :id="ids.typeError" class="field-error">{{ errors.type }}</p>

      <div v-if="form.type === 'lease'" class="form-group itf-lease">
        <label class="form-label" :for="ids.amount">Monthly amount *</label>
        <div class="itf-amount">
          <span class="itf-amount-prefix" aria-hidden="true">$</span>
          <input
            :id="ids.amount"
            ref="amountRef"
            v-model="form.amount"
            class="form-input"
            data-test="invite-amount"
            type="text"
            inputmode="numeric"
            autocomplete="off"
            placeholder="2000"
            :maxlength="LIMITS.AMOUNT_RAW_MAX"
            :aria-invalid="!!errors.amount"
            :aria-describedby="`${ids.amountHint}${errors.amount ? ` ${ids.amountError}` : ''}`"
          />
        </div>
        <p :id="ids.amountHint" class="field-hint">Whole dollars between {{ minAmount }} and {{ maxAmount }} a month, with no commas.</p>
        <p v-if="errors.amount" :id="ids.amountError" class="field-error">{{ errors.amount }}</p>
        <!-- Until the server says lease payouts are on (and while it has not
             answered, or could not), payouts ignore the lease: say so. -->
        <p v-if="leasePayoutsOff(payoutSettings)" class="itf-msg itf-msg-warn" role="note" data-test="invite-lease-warning">This changes the contract only. Payouts are still calculated from the Split % column.</p>
      </div>

      <div class="form-group">
        <div class="itf-label-row">
          <label class="form-label" :for="ids.details">Additional terms</label>
          <span :id="ids.counter" class="itf-counter" :class="{ 'is-over': form.details.length > LIMITS.DETAILS_MAX }">{{ form.details.length }}/{{ LIMITS.DETAILS_MAX }}</span>
        </div>
        <textarea
          :id="ids.details"
          ref="detailsRef"
          v-model="form.details"
          class="form-input form-textarea"
          data-test="invite-details"
          rows="5"
          :aria-invalid="!!errors.details"
          :aria-describedby="`${ids.counter} ${ids.detailsHint}${errors.details ? ` ${ids.detailsError}` : ''}`"
        ></textarea>
        <p :id="ids.detailsHint" class="field-hint">{{ detailsHint }}</p>
        <p v-if="errors.details" :id="ids.detailsError" class="field-error">{{ errors.details }}</p>
      </div>
    </template>

    <div v-if="formError" class="itf-msg itf-msg-error" role="alert" data-test="invite-form-error">
      <span>{{ formError }}</span>
      <button v-if="canReload" type="button" class="itf-link" :disabled="reloading" @click="loadLatest">
        {{ reloading ? 'Loading…' : 'Load the latest terms' }}
      </button>
    </div>

    <div class="itf-actions">
      <button type="button" class="btn btn-secondary" @click="$emit('cancel')">{{ readOnly ? 'Close' : 'Cancel' }}</button>
      <button
        v-if="!readOnly"
        type="submit"
        class="btn btn-primary"
        :data-test="isEdit ? 'invite-save' : 'invite-create'"
        :disabled="saving"
      >
        {{ saving ? 'Saving…' : isEdit ? 'Save terms' : 'Create invite' }}
      </button>
    </div>
  </form>
</template>

<script setup>
import { computed, nextTick, reactive, ref, useId, watch } from 'vue'
import { useInvestorInvitesStore } from '../../stores/investorInvites'
import { useApi } from '../../composables/useApi'
import { LIMITS, normalizeTermsInput } from '../../lib/paymentTerms'
import { formatLeaseAmount, leasePayoutsOff } from './payoutBasis'
import { checkEmail } from '../../lib/emailAddress'
import { replyLost } from '../../lib/saveOutcome'
import { fmtTimestamp } from '../../utils/datetime'
import PaymentTermsSummary from './PaymentTermsSummary.vue'

const props = defineProps({
  // The invite being edited (an AdminInvite), or null to create one.
  invite: { type: Object, default: null },
})

const emit = defineEmits(['created', 'saved', 'cancel'])

const store = useInvestorInvitesStore()
const api = useApi()

// GET /api/investor-payout-settings, or null while pending or after a failure
// (both keep the lease warning up).
const payoutSettings = ref(null)
api.get('/api/investor-payout-settings')
  .then((data) => { payoutSettings.value = data })
  .catch(() => { payoutSettings.value = null })

const uid = useId()
const ids = {
  name: `itf-name-${uid}`,
  nameError: `itf-name-error-${uid}`,
  email: `itf-email-${uid}`,
  emailError: `itf-email-error-${uid}`,
  type: `itf-type-${uid}`,
  typeError: `itf-type-error-${uid}`,
  amount: `itf-amount-${uid}`,
  amountHint: `itf-amount-hint-${uid}`,
  amountError: `itf-amount-error-${uid}`,
  details: `itf-details-${uid}`,
  detailsHint: `itf-details-hint-${uid}`,
  detailsError: `itf-details-error-${uid}`,
  counter: `itf-counter-${uid}`,
}

const nameRef = ref(null)
const emailRef = ref(null)
const typeRef = ref(null)
const amountRef = ref(null)
const detailsRef = ref(null)
const fieldRefs = { name: nameRef, email: emailRef, type: typeRef, amount: amountRef, details: detailsRef }

const form = reactive({ name: '', email: '', type: 'split', amount: '', details: '' })
const errors = reactive({ name: '', email: '', type: '', amount: '', details: '' })
const formError = ref('')
const canReload = ref(false)
const saving = ref(false)
const reloading = ref(false)
const attempted = ref(false)
// The server refused the save because the invite is used or revoked.
const lockedByServer = ref('')
// The terms revision this edit started from; sent back as expectedRevision.
const baseRevision = ref(null)

const isEdit = computed(() => !!props.invite)
const minAmount = formatLeaseAmount(LIMITS.LEASE_MIN_CENTS / 100)
const maxAmount = formatLeaseAmount(LIMITS.LEASE_MAX_CENTS / 100)

const readOnly = computed(() =>
  isEdit.value && (props.invite.status === 'used' || props.invite.status === 'revoked' || !!lockedByServer.value),
)
const readOnlyText = computed(() => {
  if (lockedByServer.value) return lockedByServer.value
  if (props.invite?.status === 'revoked') return 'This invite has been revoked, so its terms can no longer be changed.'
  const when = props.invite?.usedAt ? ` on ${fmtTimestamp(props.invite.usedAt)}` : ''
  return `This invite was used for an application${when}. Its terms are locked.`
})

const detailsHint = computed(() => {
  const base = `Printed on the Master Agreement and the Vehicle Lease as Amendment No. 1, at most ${LIMITS.DETAILS_MAX_LINES} lines.`
  return form.type === 'split' ? `${base} Leave it empty for the standard contract with no amendment.` : base
})

// Whole dollars as typed ("2000"). An older invite's amount with cents keeps
// them, so the form shows it and refuses it until it is corrected.
function centsToInput(cents) {
  if (!Number.isSafeInteger(cents)) return ''
  const dollars = Math.floor(cents / 100)
  return cents % 100 ? `${dollars}.${String(cents % 100).padStart(2, '0')}` : String(dollars)
}

function fillFrom(invite) {
  const terms = invite?.paymentTerms || null
  form.name = invite?.inviteeName || ''
  form.email = invite?.inviteeEmail || ''
  form.type = terms?.type === 'lease' ? 'lease' : 'split'
  form.amount = terms?.type === 'lease' ? centsToInput(terms.leaseAmountCents) : ''
  form.details = terms?.details || ''
  baseRevision.value = invite ? invite.termsRevision : null
}

function clearErrors() {
  for (const key of Object.keys(errors)) errors[key] = ''
  formError.value = ''
  canReload.value = false
}

fillFrom(props.invite)

// Checks what the server will check, and returns the request body, or null
// with each problem beside its field.
function validate() {
  for (const key of Object.keys(errors)) errors[key] = ''
  const name = form.name.trim()
  if (!name) errors.name = "Enter the invitee's name."
  else if (name.length > LIMITS.NAME_MAX) errors.name = `The name can be at most ${LIMITS.NAME_MAX} characters.`

  const email = form.email.trim()
  if (email) {
    const checked = checkEmail(email)
    if (!checked.ok) errors.email = checked.message
  }

  const terms = normalizeTermsInput({
    paymentType: form.type,
    leaseAmount: form.type === 'lease' ? form.amount : undefined,
    details: form.details,
  })
  if (!terms.ok) errors[slotFor(terms.field)] = terms.message

  if (Object.values(errors).some(Boolean)) return null
  const body = { inviteeName: name, inviteeEmail: email, paymentType: form.type, details: terms.value.details }
  if (form.type === 'lease') body.leaseAmount = form.amount.trim()
  return body
}

watch(form, () => { if (attempted.value) validate() })

// The server names a field by its request key.
const FIELD_SLOTS = {
  inviteeName: 'name',
  inviteeEmail: 'email',
  paymentType: 'type',
  leaseAmount: 'amount',
  leaseAmountCents: 'amount',
  details: 'details',
}
function slotFor(field) {
  return FIELD_SLOTS[field] || (field in errors ? field : '')
}

const REFUSALS = {
  INVITE_LOCKED: 'This invite has already been used for an application, so its terms are locked.',
  INVITE_REVOKED: 'This invite has been revoked, so its terms can no longer be changed.',
  INVITE_REVISION_CONFLICT: 'These terms were changed somewhere else after you opened them. Load the latest terms, then make your change again.',
  REVISION_REQUIRED: 'This save was sent without the terms version it started from. Load the latest terms, then try again.',
  INVITE_NOT_FOUND: 'This invite no longer exists.',
}

async function focusFirstError() {
  await nextTick()
  const slot = ['name', 'email', 'type', 'amount', 'details'].find((key) => errors[key])
  fieldRefs[slot]?.value?.focus()
}

function showRefusal(err) {
  const code = err?.code || ''
  if (code === 'INVALID_PAYMENT_TERMS' || code === 'INVALID_FIELD' || code === 'INVALID_EMAIL') {
    const slot = code === 'INVALID_EMAIL' ? 'email' : slotFor(err.data?.field)
    // The amount field is only on screen for a lease.
    if (slot && (slot !== 'amount' || form.type === 'lease')) {
      errors[slot] = err.message
      focusFirstError()
      return
    }
  }
  if (code === 'INVITE_LOCKED' || code === 'INVITE_REVOKED') {
    lockedByServer.value = REFUSALS[code]
    store.refresh()
    return
  }
  if (REFUSALS[code]) {
    formError.value = REFUSALS[code]
    canReload.value = code === 'INVITE_REVISION_CONFLICT' || code === 'REVISION_REQUIRED'
    return
  }
  if (replyLost(err)) {
    formError.value = isEdit.value
      ? 'The server did not confirm the save. Load the latest terms to see whether it went through.'
      : 'The server did not confirm the invite. Check the list before trying again, so the same person does not get two invites.'
    canReload.value = isEdit.value
    store.refresh()
    return
  }
  formError.value = err?.message || 'The invite could not be saved.'
}

async function submit() {
  if (saving.value || readOnly.value) return
  attempted.value = true
  clearErrors()
  const body = validate()
  if (!body) {
    focusFirstError()
    return
  }
  saving.value = true
  try {
    if (isEdit.value) {
      const data = await store.update(props.invite.id, body, baseRevision.value)
      emit('saved', { invite: data.invite, previousRevision: baseRevision.value })
    } else {
      const data = await store.create(body)
      emit('created', data)
    }
  } catch (err) {
    showRefusal(err)
  } finally {
    saving.value = false
  }
}

// After a conflict: re-read the list, then start again from the server's copy.
async function loadLatest() {
  reloading.value = true
  try {
    await store.list()
    const latest = store.invites.find((i) => i.id === props.invite?.id)
    if (!latest) {
      formError.value = 'This invite is not in the list any more. Close this form and check the status filter.'
      canReload.value = false
      return
    }
    fillFrom(latest)
    attempted.value = false
    clearErrors()
  } catch (err) {
    formError.value = `Couldn't load the latest terms (${err?.message || 'no answer'}).`
  } finally {
    reloading.value = false
  }
}
</script>

<style scoped>
.itf { display: flex; flex-direction: column; }
.form-group { margin-bottom: 0.85rem; }

.itf-types {
  border: none;
  padding: 0;
  margin: 0 0 0.85rem;
  display: grid;
  grid-template-columns: 1fr 1fr;
  gap: 0.5rem;
}
.itf-types legend { margin-bottom: 0.35rem; }
.itf-type {
  display: flex;
  gap: 0.55rem;
  align-items: flex-start;
  padding: 0.65rem 0.75rem;
  border: 1.5px solid var(--border);
  border-radius: 8px;
  cursor: pointer;
  background: var(--bg);
  transition: border-color 0.15s, background 0.15s;
}
.itf-type.is-selected {
  border-color: var(--accent);
  background: var(--accent-dim);
}
.itf-type input { margin-top: 0.2rem; accent-color: var(--accent); }
.itf-type input:focus-visible { outline: 2px solid var(--accent); outline-offset: 2px; }
.itf-type span { display: flex; flex-direction: column; gap: 0.15rem; }
.itf-type strong { font-size: 0.82rem; color: var(--text); }
.itf-type small { font-size: 0.72rem; color: var(--text-dim); line-height: 1.35; }

.itf-amount { position: relative; display: flex; align-items: center; max-width: 220px; }
.itf-amount-prefix {
  position: absolute;
  left: 0.75rem;
  font-size: 0.85rem;
  color: var(--text-dim);
  pointer-events: none;
}
.itf-amount .form-input { padding-left: 1.5rem; font-family: 'JetBrains Mono', monospace; }

.itf-label-row { display: flex; justify-content: space-between; align-items: baseline; }
.itf-counter { font-size: 0.72rem; color: var(--text-dim); font-family: 'JetBrains Mono', monospace; }
.itf-counter.is-over { color: var(--danger); font-weight: 700; }

.field-hint { margin: 0.3rem 0 0; font-size: 0.72rem; color: var(--text-dim); line-height: 1.4; }
.field-error { margin: 0.3rem 0 0; font-size: 0.75rem; color: var(--danger); }

.itf-msg {
  display: flex;
  align-items: flex-start;
  justify-content: space-between;
  gap: 0.75rem;
  margin: 0.5rem 0 0;
  padding: 0.55rem 0.7rem;
  border-radius: 8px;
  font-size: 0.78rem;
  line-height: 1.45;
}
.itf-msg-warn { background: var(--amber-dim); color: #92400e; }
.itf-msg-note { background: var(--bg); color: var(--text-dim); margin: 0 0 0.85rem; }
.itf-msg-error { background: var(--danger-dim); color: #b91c1c; }
.itf-link {
  flex-shrink: 0;
  background: none;
  border: none;
  padding: 0;
  font: inherit;
  font-weight: 700;
  color: inherit;
  text-decoration: underline;
  cursor: pointer;
}
.itf-link:disabled { opacity: 0.6; cursor: default; }

.itf-who {
  display: grid;
  grid-template-columns: 1fr 1fr;
  gap: 0.5rem 1rem;
  margin: 0 0 0.75rem;
}
.itf-who dt {
  font-size: 0.7rem;
  font-weight: 600;
  color: var(--text-dim);
  text-transform: uppercase;
  letter-spacing: 0.04em;
}
.itf-who dd { margin: 0; font-size: 0.85rem; color: var(--text); overflow-wrap: anywhere; }

.itf-actions {
  display: flex;
  justify-content: flex-end;
  gap: 0.5rem;
  margin-top: 1.25rem;
}

@media (max-width: 600px) {
  .itf-types, .itf-who { grid-template-columns: 1fr; }
}
</style>
