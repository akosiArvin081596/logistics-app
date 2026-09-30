<template>
  <!-- What payouts use for this investor: the Split % of net profit, or a fixed
       monthly lease from a given month. Beside the signed payment terms, which
       it may differ from. Messages stay inline: this sits in a modal above the
       toast layer. -->
  <section class="basis-section" data-test="payout-basis-panel" :aria-labelledby="titleId">
    <h4 :id="titleId" class="basis-title">
      <svg xmlns="http://www.w3.org/2000/svg" width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><rect x="2" y="6" width="20" height="12" rx="2"/><circle cx="12" cy="12" r="2.5"/><path d="M6 12h.01M18 12h.01"/></svg>
      Payout Basis
    </h4>

    <p v-if="!ownerId" class="basis-muted" data-test="payout-basis-no-login">
      No portal login yet. A payout basis can be set once this investor has one.
    </p>
    <p v-else-if="loading && !view" class="basis-muted" role="status">Loading the payout basis…</p>
    <div v-else-if="loadError && !view" class="basis-msg basis-msg-error" role="alert" data-test="payout-basis-load-error">
      <span>{{ loadError }}</span>
      <button type="button" class="basis-link" @click="load">Retry</button>
    </div>
    <template v-else-if="view">
      <p :class="['basis-msg', `basis-msg-${status.tone}`]" role="note" data-test="payout-basis-status">{{ status.text }}</p>

      <dl class="basis-grid">
        <div class="basis-item basis-full">
          <dt class="basis-label">Current basis</dt>
          <dd class="basis-value basis-strong" data-test="payout-basis-current">{{ currentText }}</dd>
        </div>
        <div class="basis-item">
          <dt class="basis-label">Source</dt>
          <dd class="basis-value" data-test="payout-basis-source">{{ sourceLabel(view.current?.source) }}</dd>
        </div>
        <div class="basis-item">
          <dt class="basis-label">Signed terms</dt>
          <dd class="basis-value" data-test="payout-basis-signed">{{ signedTermsText(view.signedTerms) }}</dd>
        </div>
      </dl>
      <p v-if="differsFromSigned(view.current, view.signedTerms)" class="basis-msg basis-msg-warn" role="note" data-test="payout-basis-differs">
        The current basis differs from the signed terms.
      </p>

      <h5 class="basis-sub">Schedule</h5>
      <p v-if="!schedule.length" class="basis-muted">Nothing recorded. Every month uses the Split %.</p>
      <ol v-else class="basis-list" data-test="payout-basis-schedule">
        <li v-for="row in schedule" :key="row.id" class="basis-row">
          <span class="basis-row-main">{{ describeBasis(row) }}</span>
          <span class="basis-row-meta">
            {{ sourceLabel(row.source) }} · {{ row.updatedBy || row.createdBy }}, {{ fmtTimestamp(row.updatedAt || row.createdAt) }}
          </span>
          <span v-if="row.note" class="basis-row-note">{{ row.note }}</span>
        </li>
      </ol>

      <h5 class="basis-sub">Lease settings</h5>
      <ul class="basis-settings" data-test="payout-basis-settings">
        <li v-for="line in settingsLines(view.settings)" :key="line">{{ line }}</li>
      </ul>

      <p v-if="savedText" ref="savedRef" class="basis-msg basis-msg-ok" role="status" tabindex="-1" data-test="payout-basis-saved">{{ savedText }}</p>

      <button
        v-if="!editing"
        ref="editButtonRef"
        type="button"
        class="basis-btn"
        data-test="payout-basis-edit"
        @click="startEdit"
      >Change payout basis</button>

      <form v-else class="basis-form" novalidate data-test="payout-basis-form" :aria-labelledby="formTitleId" @submit.prevent="save">
        <h5 :id="formTitleId" class="basis-sub basis-form-title">Change payout basis</h5>

        <fieldset class="basis-types" :aria-describedby="errors.type ? ids.typeError : undefined">
          <legend class="basis-label">Basis</legend>
          <label class="basis-type" :class="{ 'is-selected': form.type === 'split' }">
            <input ref="typeRef" v-model="form.type" type="radio" value="split" :name="ids.type" data-test="payout-basis-type-split" />
            <span>
              <strong>Split % of net profit</strong>
              <small>The Split % in the Investor Directory.</small>
            </span>
          </label>
          <label class="basis-type" :class="{ 'is-selected': form.type === 'lease' }">
            <input ref="leaseTypeRef" v-model="form.type" type="radio" value="lease" :name="ids.type" data-test="payout-basis-type-lease" />
            <span>
              <strong>{{ LEASE_LABEL }}</strong>
              <small>A set amount each month, whatever the truck's net profit.</small>
            </span>
          </label>
        </fieldset>
        <p v-if="errors.type" :id="ids.typeError" class="field-error">{{ errors.type }}</p>

        <div class="basis-fields">
          <div v-if="form.type === 'lease'" class="basis-field">
            <label class="basis-label" :for="ids.amount">Monthly lease amount *</label>
            <div class="basis-amount">
              <span class="basis-amount-prefix" aria-hidden="true">$</span>
              <input
                :id="ids.amount"
                ref="amountRef"
                v-model="form.amount"
                class="basis-input"
                type="text"
                inputmode="numeric"
                autocomplete="off"
                placeholder="2000"
                :maxlength="LIMITS.AMOUNT_RAW_MAX"
                data-test="payout-basis-amount"
                :aria-invalid="!!errors.amount"
                :aria-describedby="`${ids.amountHint}${errors.amount ? ` ${ids.amountError}` : ''}`"
              />
            </div>
            <p :id="ids.amountHint" class="field-hint">Whole dollars between {{ minAmount }} and {{ maxAmount }}, with no commas.</p>
            <p v-if="errors.amount" :id="ids.amountError" class="field-error">{{ errors.amount }}</p>
          </div>

          <div class="basis-field">
            <label class="basis-label" :for="ids.month">Applies from *</label>
            <input
              :id="ids.month"
              ref="monthRef"
              v-model="form.month"
              class="basis-input basis-month"
              type="month"
              :min="bounds.min || undefined"
              :max="bounds.max"
              placeholder="YYYY-MM"
              data-test="payout-basis-month"
              :aria-invalid="!!errors.month"
              :aria-describedby="`${ids.monthHint}${errors.month ? ` ${ids.monthError}` : ''}`"
            />
            <p :id="ids.monthHint" class="field-hint">{{ monthHint }}</p>
            <p v-if="errors.month" :id="ids.monthError" class="field-error">{{ errors.month }}</p>
          </div>
        </div>

        <div class="basis-field">
          <div class="basis-label-row">
            <label class="basis-label" :for="ids.note">Note</label>
            <span :id="ids.counter" class="basis-counter" :class="{ 'is-over': form.note.length > NOTE_MAX }">{{ form.note.length }}/{{ NOTE_MAX }}</span>
          </div>
          <textarea
            :id="ids.note"
            ref="noteRef"
            v-model="form.note"
            class="basis-input basis-textarea"
            rows="2"
            data-test="payout-basis-note"
            :aria-invalid="!!errors.note"
            :aria-describedby="`${ids.counter}${errors.note ? ` ${ids.noteError}` : ''}`"
          ></textarea>
          <p v-if="errors.note" :id="ids.noteError" class="field-error">{{ errors.note }}</p>
        </div>

        <p class="basis-msg basis-msg-note" role="note" data-test="payout-basis-explain">
          The change applies from the month you pick and replaces anything scheduled after it. It never alters a settled
          month: a month already processing, paid or closed keeps its figure.<template v-if="!view.enabled"> Lease payouts
          are switched off, so the change is recorded and payouts keep using the Split % until they are switched on.</template>
        </p>
        <p v-if="preview" class="basis-preview" data-test="payout-basis-preview">Saving records: {{ preview }}.</p>

        <div v-if="formError" class="basis-msg basis-msg-error" role="alert" data-test="payout-basis-form-error">
          <span>{{ formError }}</span>
          <button v-if="canReload" type="button" class="basis-link" @click="load">Reload</button>
        </div>

        <div class="basis-actions">
          <button type="button" class="btn btn-secondary" :disabled="saving" @click="cancelEdit">Cancel</button>
          <button type="submit" class="btn btn-primary" :disabled="saving" data-test="payout-basis-save">
            {{ saving ? 'Saving…' : 'Save payout basis' }}
          </button>
        </div>
      </form>

      <h5 class="basis-sub">Change history</h5>
      <p v-if="!history.length" class="basis-muted">No changes recorded.</p>
      <ol v-else class="basis-list basis-history" data-test="payout-basis-history">
        <li v-for="(h, i) in history" :key="`${h.at}-${i}`" class="basis-row">
          <span class="basis-row-main">{{ h.detail || h.action }}</span>
          <span class="basis-row-meta">{{ h.actor }}, {{ fmtTimestamp(h.at) }}</span>
        </li>
      </ol>
    </template>
  </section>
</template>

<script setup>
import { computed, nextTick, onBeforeUnmount, reactive, ref, useId, watch } from 'vue'
import { useApi } from '../../composables/useApi'
import { replyLost } from '../../lib/saveOutcome'
import { monthLabel } from '../../lib/monthLabel'
import { LIMITS, MESSAGES } from '../../lib/paymentTerms'
import { fmtTimestamp, houstonToday } from '../../utils/datetime'
import {
  LEASE_LABEL,
  NOTE_MAX,
  basisStatus,
  currentBasisText,
  describeBasis,
  differsFromSigned,
  formatLeaseAmount,
  monthBounds,
  settingsLines,
  signedTermsText,
  sourceLabel,
  validateBasisForm,
} from './payoutBasis'

const props = defineProps({
  // investors.id, as /api/investors/:id/payment-terms takes it.
  investorId: { type: Number, required: true },
  // The investor's users.id; 0 when they have no portal login, which a basis needs.
  ownerId: { type: Number, default: 0 },
})

const emit = defineEmits(['saved'])

const api = useApi()
const uid = useId()
const titleId = `payout-basis-title-${uid}`
const formTitleId = `payout-basis-form-title-${uid}`
const ids = {
  type: `pb-type-${uid}`,
  typeError: `pb-type-error-${uid}`,
  amount: `pb-amount-${uid}`,
  amountHint: `pb-amount-hint-${uid}`,
  amountError: `pb-amount-error-${uid}`,
  month: `pb-month-${uid}`,
  monthHint: `pb-month-hint-${uid}`,
  monthError: `pb-month-error-${uid}`,
  note: `pb-note-${uid}`,
  noteError: `pb-note-error-${uid}`,
  counter: `pb-counter-${uid}`,
}

const view = ref(null)
const loading = ref(false)
const loadError = ref('')
const editing = ref(false)
const saving = ref(false)
const savedText = ref('')
const formError = ref('')
const canReload = ref(false)
const attempted = ref(false)
const form = reactive({ type: 'split', amount: '', month: '', note: '' })
const errors = reactive({ type: '', amount: '', month: '', note: '' })

const typeRef = ref(null)
const leaseTypeRef = ref(null)
const amountRef = ref(null)
const monthRef = ref(null)
const noteRef = ref(null)
const editButtonRef = ref(null)
const savedRef = ref(null)
const fieldRefs = { type: typeRef, amount: amountRef, month: monthRef, note: noteRef }

const minAmount = formatLeaseAmount(LIMITS.LEASE_MIN_CENTS / 100)
const maxAmount = formatLeaseAmount(LIMITS.LEASE_MAX_CENTS / 100)

let ticket = 0

const schedule = computed(() => (Array.isArray(view.value?.schedule) ? view.value.schedule : []))
const history = computed(() => (Array.isArray(view.value?.history) ? view.value.history : []))
const status = computed(() => basisStatus(view.value))
const currentText = computed(() => currentBasisText(view.value?.current))
const bounds = computed(() => monthBounds(houstonToday(), view.value?.earliestEditableMonth))
const monthHint = computed(() => {
  const last = monthLabel(bounds.value.max)
  return bounds.value.min
    ? `From ${monthLabel(bounds.value.min)} to ${last}. Earlier months are settled.`
    : `Up to ${last}.`
})

// The body the form would send, in words, once it is valid.
const preview = computed(() => {
  const checked = validateBasisForm(form, bounds.value)
  if (!checked.ok) return ''
  return describeBasis({ ...checked.body, splitPct: view.value?.current?.splitPct })
})

async function load() {
  if (!props.ownerId) return
  const mine = ++ticket
  loading.value = true
  loadError.value = ''
  try {
    const data = await api.get(`/api/investors/${encodeURIComponent(props.investorId)}/payout-basis`)
    if (mine !== ticket) return
    view.value = data
    formError.value = ''
    canReload.value = false
  } catch (err) {
    if (mine !== ticket) return
    if (editing.value && view.value) {
      formError.value = `Couldn't reload the payout basis (${err?.message || 'no answer'}).`
    } else {
      view.value = null
      loadError.value = err?.code === 'INVESTOR_NOT_FOUND' || err?.status === 404
        ? 'This investor no longer exists.'
        : `Couldn't load the payout basis (${err?.message || 'no answer'}).`
    }
  } finally {
    if (mine === ticket) loading.value = false
  }
}

function clearErrors() {
  for (const key of Object.keys(errors)) errors[key] = ''
  formError.value = ''
  canReload.value = false
}

async function startEdit() {
  const current = view.value?.current || {}
  form.type = current.type === 'lease' ? 'lease' : 'split'
  form.amount = current.type === 'lease' && Number.isFinite(Number(current.leaseAmount)) ? String(current.leaseAmount) : ''
  form.month = bounds.value.start
  form.note = ''
  attempted.value = false
  savedText.value = ''
  clearErrors()
  editing.value = true
  await nextTick()
  ;(form.type === 'lease' ? leaseTypeRef : typeRef).value?.focus()
}

async function cancelEdit() {
  editing.value = false
  clearErrors()
  await nextTick()
  editButtonRef.value?.focus()
}

function validate() {
  const checked = validateBasisForm(form, bounds.value)
  for (const key of Object.keys(errors)) errors[key] = checked.ok ? '' : checked.errors[key] || ''
  return checked.ok ? checked.body : null
}

watch(form, () => { if (attempted.value) validate() })

async function focusFirstError() {
  await nextTick()
  const slot = ['type', 'amount', 'month', 'note'].find((key) => errors[key])
  fieldRefs[slot]?.value?.focus()
}

// The server names a refused field by its request key.
const FIELD_SLOTS = { type: 'type', leaseAmount: 'amount', effectiveMonth: 'month', note: 'note' }

function showRefusal(err) {
  const code = err?.code || ''
  if (code === 'LEASE_AMOUNT_WHOLE_DOLLARS') {
    errors.amount = MESSAGES.invalid_amount
    focusFirstError()
    return
  }
  if (code === 'BASIS_MONTH_CLOSED') {
    const earliest = err.data?.earliestEditableMonth || view.value?.earliestEditableMonth
    errors.month = earliest
      ? `That month is already settled for this investor, so it can't change. Pick ${monthLabel(earliest)} or later.`
      : "That month is already settled for this investor, so it can't change. Pick a later month."
    focusFirstError()
    load()
    return
  }
  if (code === 'INVALID_BASIS') {
    const slot = FIELD_SLOTS[err.data?.field]
    if (slot && (slot !== 'amount' || form.type === 'lease')) {
      errors[slot] = err.message
      focusFirstError()
    } else {
      formError.value = err.message || 'The payout basis was refused.'
    }
    return
  }
  if (code === 'INVESTOR_NOT_FOUND' || err?.status === 404) {
    formError.value = 'This investor no longer exists.'
    return
  }
  if (replyLost(err)) {
    formError.value = 'The server did not confirm the save. Reload to see whether it went through.'
    canReload.value = true
    return
  }
  formError.value = err?.message || 'The payout basis could not be saved.'
}

async function save() {
  if (saving.value) return
  attempted.value = true
  clearErrors()
  const body = validate()
  if (!body) {
    focusFirstError()
    return
  }
  saving.value = true
  const words = describeBasis({ ...body, splitPct: view.value?.current?.splitPct })
  try {
    const data = await api.put(`/api/investors/${encodeURIComponent(props.investorId)}/payout-basis`, body)
    ticket += 1
    view.value = data
    editing.value = false
    savedText.value = `Saved: ${words}.`
    emit('saved')
    await nextTick()
    savedRef.value?.focus()
  } catch (err) {
    showRefusal(err)
  } finally {
    saving.value = false
  }
}

watch(() => [props.investorId, props.ownerId], load, { immediate: true })
onBeforeUnmount(() => { ticket += 1 })
</script>

<style scoped>
.basis-section { margin: 0; }
.basis-title {
  display: flex;
  align-items: center;
  gap: 0.5rem;
  margin: 0 0 0.75rem;
  font-size: 0.82rem;
  font-weight: 700;
  color: var(--text);
  text-transform: uppercase;
  letter-spacing: 0.04em;
}
.basis-title svg { color: #3b82f6; }
.basis-sub {
  margin: 1rem 0 0.4rem;
  font-size: 0.72rem;
  font-weight: 700;
  color: var(--text-dim);
  text-transform: uppercase;
  letter-spacing: 0.04em;
}
.basis-muted { margin: 0; font-size: 0.82rem; color: var(--text-dim); }

.basis-grid {
  display: grid;
  grid-template-columns: 1fr 1fr;
  gap: 0.5rem 1rem;
  margin: 0.75rem 0 0;
}
.basis-item { display: flex; flex-direction: column; gap: 0.1rem; min-width: 0; }
.basis-full { grid-column: 1 / -1; }
.basis-label {
  font-size: 0.7rem;
  font-weight: 600;
  color: var(--text-dim);
  text-transform: uppercase;
  letter-spacing: 0.04em;
}
.basis-value { margin: 0; font-size: 0.85rem; font-weight: 500; color: var(--text); overflow-wrap: anywhere; }
.basis-strong { font-weight: 700; }

.basis-msg {
  display: flex;
  align-items: flex-start;
  justify-content: space-between;
  gap: 0.75rem;
  margin: 0.5rem 0 0;
  padding: 0.5rem 0.7rem;
  border-radius: 8px;
  font-size: 0.78rem;
  line-height: 1.45;
}
.basis-msg-warn { background: var(--amber-dim); color: #92400e; }
.basis-msg-ok { background: var(--accent-dim); color: #047857; font-weight: 600; }
.basis-msg-muted,
.basis-msg-note { background: var(--bg); color: var(--text-dim); display: block; }
.basis-msg-error { background: var(--danger-dim); color: #b91c1c; }
.basis-msg:focus { outline: 2px solid var(--blue); outline-offset: 2px; }
.basis-link {
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

.basis-list { margin: 0; padding: 0; list-style: none; display: flex; flex-direction: column; gap: 0.35rem; }
.basis-row {
  display: flex;
  flex-direction: column;
  gap: 0.1rem;
  padding: 0.45rem 0.6rem;
  border: 1px solid var(--border);
  border-radius: 8px;
  background: var(--bg);
}
.basis-row-main { font-size: 0.82rem; font-weight: 600; color: var(--text); overflow-wrap: anywhere; }
.basis-row-meta { font-size: 0.72rem; color: var(--text-dim); }
.basis-row-note { font-size: 0.75rem; color: var(--text); white-space: pre-wrap; overflow-wrap: anywhere; }
.basis-history { max-height: 12rem; overflow-y: auto; }

.basis-settings { margin: 0; padding-left: 1.1rem; list-style: disc; font-size: 0.8rem; color: var(--text); line-height: 1.5; }

.basis-btn {
  margin-top: 0.85rem;
  padding: 0.4rem 0.8rem;
  font-size: 0.75rem;
  font-weight: 600;
  font-family: inherit;
  border: 1px solid var(--blue-dim);
  border-radius: 6px;
  background: var(--blue-dim);
  color: var(--blue);
  cursor: pointer;
  transition: all 0.15s;
}
.basis-btn:hover { background: var(--blue); color: #fff; border-color: var(--blue); }
.basis-btn:focus-visible { outline: 2px solid var(--blue); outline-offset: 2px; }

.basis-form {
  margin-top: 0.85rem;
  padding: 0.85rem;
  border: 1px solid var(--border);
  border-radius: 10px;
}
.basis-form-title { margin-top: 0; }
.basis-types {
  border: none;
  padding: 0;
  margin: 0 0 0.5rem;
  display: grid;
  grid-template-columns: 1fr 1fr;
  gap: 0.5rem;
}
.basis-types legend { margin-bottom: 0.35rem; }
.basis-type {
  display: flex;
  gap: 0.55rem;
  align-items: flex-start;
  padding: 0.6rem 0.7rem;
  border: 1.5px solid var(--border);
  border-radius: 8px;
  cursor: pointer;
  background: var(--bg);
  transition: border-color 0.15s, background 0.15s;
}
.basis-type.is-selected { border-color: var(--accent); background: var(--accent-dim); }
.basis-type input { margin-top: 0.2rem; accent-color: var(--accent); }
.basis-type input:focus-visible { outline: 2px solid var(--accent); outline-offset: 2px; }
.basis-type span { display: flex; flex-direction: column; gap: 0.15rem; }
.basis-type strong { font-size: 0.8rem; color: var(--text); }
.basis-type small { font-size: 0.72rem; color: var(--text-dim); line-height: 1.35; }

.basis-fields { display: flex; flex-wrap: wrap; gap: 0.75rem 1rem; }
.basis-field { display: flex; flex-direction: column; gap: 0.3rem; margin-top: 0.5rem; min-width: 0; }
.basis-label-row { display: flex; justify-content: space-between; align-items: baseline; }
.basis-counter { font-size: 0.72rem; color: var(--text-dim); font-family: 'JetBrains Mono', monospace; }
.basis-counter.is-over { color: var(--danger); font-weight: 700; }
.basis-input {
  width: 100%;
  padding: 0.5rem 0.65rem;
  border: 1px solid var(--border);
  border-radius: 6px;
  font-family: inherit;
  font-size: 0.82rem;
  background: var(--bg);
  color: var(--text);
}
.basis-input:focus { outline: none; border-color: var(--blue); box-shadow: 0 0 0 2px var(--blue-dim); }
.basis-input[aria-invalid="true"] { border-color: var(--danger); }
.basis-amount { position: relative; display: flex; align-items: center; width: 180px; }
.basis-amount-prefix {
  position: absolute;
  left: 0.65rem;
  font-size: 0.82rem;
  color: var(--text-dim);
  pointer-events: none;
}
.basis-amount .basis-input { padding-left: 1.4rem; font-family: 'JetBrains Mono', monospace; }
.basis-month { width: 180px; font-family: 'JetBrains Mono', monospace; }
.basis-textarea { resize: vertical; }

.field-hint { margin: 0; font-size: 0.72rem; color: var(--text-dim); line-height: 1.4; max-width: 22rem; }
.field-error { margin: 0; font-size: 0.75rem; color: var(--danger); }

.basis-preview { margin: 0.5rem 0 0; font-size: 0.8rem; font-weight: 600; color: var(--text); }
.basis-actions { display: flex; justify-content: flex-end; gap: 0.5rem; margin-top: 0.85rem; }

@media (max-width: 600px) {
  .basis-grid, .basis-types { grid-template-columns: 1fr; }
}
</style>
