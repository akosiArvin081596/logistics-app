<template>
  <div v-if="compact" class="pts-compact">
    <span class="pts-summary">{{ labels.summary }}</span>
    <span v-if="details" class="pts-snippet" :title="details">{{ details }}</span>
  </div>
  <div v-else>
    <dl class="pts">
      <div class="pts-item">
        <dt class="pts-label">Payment type</dt>
        <dd class="pts-value">{{ labels.typeLabel }}</dd>
      </div>
      <div v-if="labels.amountLabel" class="pts-item">
        <dt class="pts-label">Monthly amount</dt>
        <dd class="pts-value">{{ labels.amountLabel }}</dd>
      </div>
      <div class="pts-item pts-full">
        <dt class="pts-label">Additional terms</dt>
        <dd class="pts-value pts-details">{{ details || 'None' }}</dd>
      </div>
    </dl>
    <p v-if="isDefault" class="pts-note">Standard contract terms, with no amendment.</p>
  </div>
</template>

<script setup>
import { computed } from 'vue'
import { describeTerms } from '../../lib/paymentTerms'

const props = defineProps({
  // The server's { typeLabel, amountLabel, summary } for these terms.
  display: { type: Object, default: null },
  // { type, leaseAmountCents, details }, or null for the standard contract.
  terms: { type: Object, default: null },
  isDefault: { type: Boolean, default: false },
  // One line for a table cell: the summary, then the start of any details.
  compact: { type: Boolean, default: false },
})

const labels = computed(() => props.display || describeTerms(props.isDefault ? null : props.terms))
const details = computed(() => (props.isDefault ? '' : props.terms?.details || ''))
</script>

<style scoped>
.pts {
  display: grid;
  grid-template-columns: 1fr 1fr;
  gap: 0.5rem 1rem;
  margin: 0;
}
.pts-item { display: flex; flex-direction: column; gap: 0.1rem; min-width: 0; }
.pts-full { grid-column: 1 / -1; }
.pts-label {
  font-size: 0.7rem;
  font-weight: 600;
  color: var(--text-dim);
  text-transform: uppercase;
  letter-spacing: 0.04em;
}
.pts-value {
  margin: 0;
  font-size: 0.85rem;
  font-weight: 500;
  color: var(--text);
}
.pts-details {
  white-space: pre-wrap;
  overflow-wrap: anywhere;
  font-weight: 400;
  line-height: 1.45;
}
.pts-note {
  margin: 0.5rem 0 0;
  font-size: 0.75rem;
  color: var(--text-dim);
}

.pts-compact {
  display: flex;
  flex-direction: column;
  gap: 0.1rem;
  min-width: 0;
}
.pts-summary { font-weight: 600; font-size: 0.8rem; color: var(--text); }
.pts-snippet {
  max-width: 260px;
  font-size: 0.72rem;
  color: var(--text-dim);
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}
@media (max-width: 600px) {
  .pts { grid-template-columns: 1fr; }
}
</style>
