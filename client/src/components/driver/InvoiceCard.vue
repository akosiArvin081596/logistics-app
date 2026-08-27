<template>
  <div class="card invoice-card" @click="$emit('tap', invoice)">
    <div class="inv-row">
      <div :class="['inv-status-dot', statusColor]"></div>
      <div class="inv-details">
        <div class="inv-number">{{ invoice.invoice_number }}</div>
        <div class="inv-week">{{ invoice.week_start }} to {{ invoice.week_end }}</div>
      </div>
      <div class="inv-right">
        <div class="inv-amount">${{ (invoice.total_earnings || 0).toFixed(2) }}</div>
        <div class="inv-amount-label">your pay</div>
        <div :class="['inv-status', statusColor]">{{ invoice.status }}</div>
      </div>
    </div>
    <div class="inv-meta">
      <span>{{ invoice.loads_count }} load{{ invoice.loads_count !== 1 ? 's' : '' }}</span>
      <!-- ⚠️ "Receipts filed", not "Expenses". This figure sat unlabelled next to
           the pay figure, and on a week like $600.00 pay / $1,140.17 of receipts
           it reads as though the driver owes the difference.
           It is deliberately NOT described as deducted or reimbursed here,
           because the relationship depends on the driver's pay model — for a
           daily-rate driver these receipts do not reduce the pay shown, while
           for an owner-operator on a percentage the fuel and maintenance ones
           were already netted off before the share was calculated. The card
           does not carry the pay model, so it states the fact it can stand
           behind and leaves the arithmetic to the PDF. -->
      <span v-if="invoice.expenses_total > 0">
        Receipts filed: ${{ invoice.expenses_total.toFixed(2) }}
      </span>
    </div>
  </div>
</template>

<script setup>
import { computed } from 'vue'

const props = defineProps({
  invoice: { type: Object, required: true },
})
defineEmits(['tap'])

const statusColor = computed(() => {
  const s = props.invoice.status
  if (s === 'Approved' || s === 'Paid') return 'status-green'
  if (s === 'Submitted') return 'status-blue'
  if (s === 'Rejected') return 'status-red'
  return 'status-gray'
})
</script>

<style scoped>
.invoice-card {
  padding: 0.75rem 1rem;
  cursor: pointer;
  transition: background 0.15s;
}
.invoice-card:active { background: var(--bg); }
.inv-row {
  display: flex;
  align-items: center;
  gap: 0.6rem;
}
.inv-status-dot {
  width: 10px;
  height: 10px;
  border-radius: 50%;
  flex-shrink: 0;
}
.inv-details { flex: 1; min-width: 0; }
.inv-number {
  font-weight: 700;
  font-size: 0.85rem;
}
.inv-week {
  font-size: 0.72rem;
  color: var(--text-dim);
}
.inv-right { text-align: right; }
.inv-amount-label {
  font-size: 0.6rem;
  color: var(--text-dim);
  text-align: right;
  margin-top: -2px;
}
.inv-amount {
  font-weight: 700;
  font-size: 0.95rem;
}
.inv-status {
  font-size: 0.68rem;
  font-weight: 600;
}
.inv-meta {
  display: flex;
  gap: 1rem;
  font-size: 0.72rem;
  color: var(--text-dim);
  margin-top: 0.25rem;
  padding-left: 1.6rem;
}
.status-green .inv-status-dot, .status-green { color: #059669; }
.status-green .inv-status-dot { background: #059669; }
.status-blue .inv-status-dot, .status-blue { color: #2563eb; }
.status-blue .inv-status-dot { background: #2563eb; }
.status-red .inv-status-dot, .status-red { color: #dc2626; }
.status-red .inv-status-dot { background: #dc2626; }
.status-gray .inv-status-dot, .status-gray { color: #9ca3af; }
.status-gray .inv-status-dot { background: #9ca3af; }
</style>
