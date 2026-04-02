<template>
  <div class="revenue-grid">
    <Card v-for="card in cards" :key="card.key" class="rev-card" :class="card.color">
      <template #content>
        <div class="rev-row">
          <span class="rev-icon">{{ card.icon }}</span>
          <div class="rev-body">
            <span class="rev-label">{{ card.label }}</span>
            <span class="rev-value" :class="card.color">{{ card.value }}</span>
          </div>
        </div>
      </template>
    </Card>
  </div>
</template>

<script setup>
import { computed } from 'vue'
import Card from 'primevue/card'

const props = defineProps({
  revenue: { type: Object, required: true },
})

function fmt(n) {
  return '$' + Number(n || 0).toLocaleString('en-US', { maximumFractionDigits: 0 })
}

const cards = computed(() => [
  { key: 'total', icon: '💰', label: 'Total Revenue', value: fmt(props.revenue.total), color: '' },
  { key: 'paid', icon: '✔', label: 'Paid', value: fmt(props.revenue.paid), color: 'accent' },
  { key: 'pending', icon: '🕐', label: 'Pending', value: fmt(props.revenue.pending), color: 'amber' },
])
</script>

<style scoped>
.revenue-grid {
  display: grid;
  grid-template-columns: repeat(3, 1fr);
  gap: 1rem;
  margin-bottom: 1rem;
}

.rev-card { border-left: 3px solid var(--border); }
.rev-card.accent { border-left-color: var(--accent); }
.rev-card.amber { border-left-color: var(--amber); }

:deep(.p-card-body) { padding: 0.9rem 1.25rem; }
:deep(.p-card-content) { padding: 0; }

.rev-row { display: flex; align-items: center; gap: 0.9rem; }
.rev-icon { font-size: 1.2rem; flex-shrink: 0; opacity: 0.8; }
.rev-body { display: flex; flex-direction: column; gap: 0.1rem; }
.rev-label { font-size: 0.72rem; font-weight: 600; text-transform: uppercase; letter-spacing: 0.05em; color: var(--text-dim); }
.rev-value { font-size: 1.35rem; font-weight: 700; font-family: 'JetBrains Mono', monospace; }
.rev-value.accent { color: var(--accent); }
.rev-value.amber { color: var(--amber); }
</style>
