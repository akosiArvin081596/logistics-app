<template>
  <div class="revenue-grid">
    <div class="revenue-card total">
      <div class="rev-icon">💰</div>
      <div class="rev-body">
        <div class="rev-label">Total Revenue</div>
        <div class="rev-value">{{ formatCurrency(revenue.total) }}</div>
      </div>
    </div>
    <div class="revenue-card paid">
      <div class="rev-icon">✔</div>
      <div class="rev-body">
        <div class="rev-label">Paid</div>
        <div class="rev-value accent">{{ formatCurrency(revenue.paid) }}</div>
      </div>
    </div>
    <div class="revenue-card pending">
      <div class="rev-icon">🕐</div>
      <div class="rev-body">
        <div class="rev-label">Pending</div>
        <div class="rev-value amber">{{ formatCurrency(revenue.pending) }}</div>
      </div>
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

<style scoped>
.revenue-grid {
  display: grid;
  grid-template-columns: repeat(3, 1fr);
  gap: 1rem;
  margin-bottom: 1rem;
}

.revenue-card {
  background: var(--surface);
  border: 1px solid var(--border);
  border-radius: var(--radius);
  padding: 0.9rem 1.25rem;
  display: flex;
  align-items: center;
  gap: 0.9rem;
  box-shadow: 0 1px 4px rgba(0,0,0,0.05);
  border-left: 3px solid var(--border);
}
.revenue-card.total  { border-left-color: var(--text-dim); }
.revenue-card.paid   { border-left-color: var(--accent); }
.revenue-card.pending { border-left-color: var(--amber); }

.rev-icon {
  font-size: 1.2rem;
  flex-shrink: 0;
  opacity: 0.8;
}

.rev-body { display: flex; flex-direction: column; gap: 0.1rem; min-width: 0; }

.rev-label {
  font-size: 0.72rem;
  font-weight: 600;
  text-transform: uppercase;
  letter-spacing: 0.05em;
  color: var(--text-dim);
}

.rev-value {
  font-size: 1.35rem;
  font-weight: 700;
  font-family: 'JetBrains Mono', monospace;
  color: var(--text);
}
.rev-value.accent { color: var(--accent); }
.rev-value.amber  { color: var(--amber); }
</style>
