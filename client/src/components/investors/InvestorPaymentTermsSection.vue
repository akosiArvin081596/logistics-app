<template>
  <!-- Read-only by decision: an investor's signed terms are shown, never edited.
       Messages stay inline because this sits in a modal above the toast layer. -->
  <section class="terms-section" data-test="investor-terms-section" :aria-labelledby="titleId">
    <h4 :id="titleId" class="terms-title">
      <svg xmlns="http://www.w3.org/2000/svg" width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><rect x="3" y="11" width="18" height="11" rx="2" ry="2"/><path d="M7 11V7a5 5 0 0 1 10 0v4"/></svg>
      Payment Terms
    </h4>

    <p v-if="loading" class="terms-muted" role="status">Loading payment terms…</p>
    <div v-else-if="error" class="terms-msg terms-msg-error" role="alert">
      <span>{{ error }}</span>
      <button type="button" class="terms-retry" @click="load">Retry</button>
    </div>
    <template v-else-if="view">
      <template v-if="view.state === 'signed'">
        <PaymentTermsSummary :display="view.display" :terms="view.paymentTerms" :is-default="view.isDefault" />
        <p class="terms-lock" data-test="investor-terms-locked">{{ lockText }}</p>
        <p v-if="view.consistent === false" class="terms-msg terms-msg-warn" role="note">
          The stored payment terms don't all agree or couldn't be read. Check the signed PDFs.
        </p>
      </template>
      <p v-else class="terms-muted" data-test="investor-terms-unsigned">No signed agreement on file</p>
      <p v-if="view.invite" class="terms-muted terms-invite">
        Applied through personal invite #{{ view.invite.id }}{{ view.invite.inviteeName ? ` for ${view.invite.inviteeName}` : '' }}, terms revision {{ view.invite.termsRevision }}.
      </p>
    </template>
  </section>
</template>

<script setup>
import { computed, onBeforeUnmount, ref, useId, watch } from 'vue'
import { useApi } from '../../composables/useApi'
import { fmtAppDate } from '../../utils/datetime'
import PaymentTermsSummary from './PaymentTermsSummary.vue'

const props = defineProps({
  investorId: { type: Number, required: true },
})

const api = useApi()
const titleId = `investor-terms-title-${useId()}`

const view = ref(null)
const loading = ref(false)
const error = ref('')
let ticket = 0

// A bare SQLite CURRENT_TIMESTAMP is UTC with no zone marker; older document
// rows may carry one. Read it as UTC, never as the viewer's local time, and show
// its date in the app zone.
const SQLITE_UTC_STAMP_RE = /^\d{4}-\d{2}-\d{2}[ T]\d{2}:\d{2}(:\d{2})?$/

function signedDay(value) {
  const s = String(value || '').trim()
  if (!s) return ''
  return fmtAppDate(new Date(SQLITE_UTC_STAMP_RE.test(s) ? `${s.replace(' ', 'T')}Z` : s), { fallback: '' })
}

const lockText = computed(() => {
  const docs = view.value?.documents || []
  const master = docs.find((d) => d.docKey === 'master_agreement' && d.signed)
  const day = signedDay(master?.signedAt)
  return day
    ? `As signed on ${day} — locked. Signed contracts never change.`
    : 'As signed — locked. Signed contracts never change.'
})

async function load() {
  const mine = ++ticket
  loading.value = true
  error.value = ''
  try {
    const data = await api.get(`/api/investors/${encodeURIComponent(props.investorId)}/payment-terms`)
    if (mine !== ticket) return
    view.value = data
  } catch (err) {
    if (mine !== ticket) return
    view.value = null
    error.value = err?.code === 'INVESTOR_NOT_FOUND'
      ? 'This investor no longer exists.'
      : `Couldn't load the payment terms (${err?.message || 'no answer'}).`
  } finally {
    if (mine === ticket) loading.value = false
  }
}

watch(() => props.investorId, load, { immediate: true })
onBeforeUnmount(() => { ticket += 1 })
</script>

<style scoped>
.terms-section { margin: 0; }
.terms-title {
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
.terms-title svg { color: #3b82f6; }
.terms-muted { margin: 0; font-size: 0.82rem; color: var(--text-dim); }
.terms-invite { margin-top: 0.5rem; font-size: 0.75rem; }
.terms-lock {
  margin: 0.75rem 0 0;
  padding: 0.5rem 0.7rem;
  border-radius: 8px;
  background: var(--bg);
  font-size: 0.78rem;
  font-weight: 600;
  color: var(--text);
}
.terms-msg {
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
.terms-msg-error { background: var(--danger-dim); color: #b91c1c; }
.terms-msg-warn { background: var(--amber-dim); color: #92400e; }
.terms-retry {
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
</style>
