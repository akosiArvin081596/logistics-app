<template>
  <!-- Read-only by design: the terms are set by LogisX on the invitation and the
       server takes them from the invitation row, never from this page. Nothing
       in here may become an input, select, textarea or contenteditable. -->
  <section class="terms-card" data-test="invite-terms-card">
    <h3 class="terms-title">
      <svg xmlns="http://www.w3.org/2000/svg" width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><line x1="12" y1="1" x2="12" y2="23"/><path d="M17 5H9.5a3.5 3.5 0 0 0 0 7h5a3.5 3.5 0 0 1 0 7H6"/></svg>
      Your payment terms
    </h3>
    <dl class="terms-list">
      <div class="terms-row">
        <dt class="terms-label">Payment type</dt>
        <dd class="terms-value" data-test="terms-type">{{ paymentTerms.typeLabel }}</dd>
      </div>
      <div v-if="paymentTerms.type === 'lease'" class="terms-row">
        <dt class="terms-label">Monthly amount</dt>
        <dd class="terms-value" data-test="terms-amount">{{ paymentTerms.amountLabel }}</dd>
      </div>
      <div class="terms-row">
        <dt class="terms-label">Additional terms</dt>
        <dd class="terms-value terms-details" data-test="terms-details">{{ paymentTerms.details || 'None' }}</dd>
      </div>
    </dl>
    <p class="terms-note">These terms were set by LogisX for your agreement and appear in Amendment No. 1 of the documents you sign.</p>
  </section>
</template>

<script setup>
defineProps({
  // { type: 'split' | 'lease', typeLabel, amountLabel, details } — see
  // paymentTermsView() in lib/investorInvite.js.
  paymentTerms: { type: Object, required: true },
})
</script>

<style scoped>
.terms-card {
  border: 1.5px solid #e9edf3;
  border-radius: 12px;
  background: #fafbfd;
  padding: 0.95rem 1.15rem;
  margin-bottom: 1rem;
  text-align: left;
  font-family: 'DM Sans', system-ui, sans-serif;
}
.terms-title {
  display: flex;
  align-items: center;
  gap: 0.5rem;
  margin: 0 0 0.75rem;
  font-size: 0.9rem;
  font-weight: 700;
  color: #0f172a;
}
.terms-title svg { color: #3b82f6; flex-shrink: 0; }
.terms-list { margin: 0; display: flex; flex-direction: column; gap: 0.6rem; }
.terms-row { display: flex; flex-direction: column; gap: 0.1rem; min-width: 0; }
.terms-label {
  font-size: 0.7rem;
  font-weight: 600;
  color: #94a3b8;
  text-transform: uppercase;
  letter-spacing: 0.04em;
}
.terms-value { margin: 0; font-size: 0.85rem; font-weight: 500; color: #0f172a; }
.terms-details { white-space: pre-wrap; overflow-wrap: anywhere; line-height: 1.5; }
.terms-note {
  margin: 0.85rem 0 0;
  padding-top: 0.65rem;
  border-top: 1px solid #e9edf3;
  font-size: 0.75rem;
  line-height: 1.5;
  color: #64748b;
}
</style>
