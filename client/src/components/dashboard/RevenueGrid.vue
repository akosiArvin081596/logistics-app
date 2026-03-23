<template>
  <div class="revenue-grid">
    <div class="revenue-card">
      <div class="rev-label">Total Revenue</div>
      <div class="rev-value">{{ formatCurrency(revenue.total) }}</div>
    </div>
    <div class="revenue-card">
      <div class="rev-label">Paid</div>
      <div class="rev-value" style="color:var(--accent)">{{ formatCurrency(revenue.paid) }}</div>
    </div>
    <div class="revenue-card">
      <div class="rev-label">Pending</div>
      <div class="rev-value" style="color:var(--amber)">{{ formatCurrency(revenue.pending) }}</div>
    </div>
  </div>
</template>

<script setup>
defineProps({
  revenue: { type: Object, required: true },
})

function formatCurrency(n) {
  return '$' + Number(n || 0).toLocaleString('en-US', { minimumFractionDigits: 0, maximumFractionDigits: 0 })
}
</script>
