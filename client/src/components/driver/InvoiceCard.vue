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
        <div :class="['inv-status', statusColor]">{{ invoice.status }}</div>
      </div>
    </div>
    <div class="inv-meta">
      <span>{{ invoice.loads_count }} load{{ invoice.loads_count !== 1 ? 's' : '' }}</span>
      <span v-if="invoice.expenses_total > 0">Expenses: ${{ invoice.expenses_total.toFixed(2) }}</span>
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
