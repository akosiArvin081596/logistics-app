<template>
  <div class="revenue-grid">
    <div v-for="card in cards" :key="card.key" class="rev-card">
      <i :class="['rev-icon pi', card.icon]"></i>
      <div class="rev-body">
        <span class="rev-label">{{ card.label }}</span>
        <span class="rev-value">{{ card.value }}</span>
      </div>
    </div>
  </div>
</template>

<script setup>
import { computed } from 'vue'

const props = defineProps({
  revenue: { type: Object, required: true },
})

function fmt(n) {
  return '$' + Number(n || 0).toLocaleString('en-US', { maximumFractionDigits: 0 })
}

const cards = computed(() => [
  { key: 'total', icon: 'pi-dollar', label: 'Total Revenue', value: fmt(props.revenue.total) },
  { key: 'paid', icon: 'pi-check', label: 'Paid', value: fmt(props.revenue.paid) },
  { key: 'pending', icon: 'pi-clock', label: 'Pending', value: fmt(props.revenue.pending) },
])
</script>

<style scoped>
.revenue-grid {
  display: grid;
  grid-template-columns: repeat(3, 1fr);
  gap: 0.75rem;
  margin-bottom: 0.75rem;
}

.rev-card {
  background: var(--surface);
  border: 1px solid var(--border);
  border-radius: 10px;
  padding: 0.85rem 1.15rem;
  display: flex;
  align-items: center;
  gap: 0.85rem;
}

.rev-icon { font-size: 1.1rem; color: var(--text-dim); }
.rev-body { display: flex; flex-direction: column; gap: 0.05rem; }
.rev-label { font-size: 0.68rem; font-weight: 600; text-transform: uppercase; letter-spacing: 0.05em; color: var(--text-dim); }
.rev-value { font-size: 1.25rem; font-weight: 700; font-family: 'JetBrains Mono', monospace; color: var(--text); }
</style>
