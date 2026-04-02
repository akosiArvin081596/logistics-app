<template>
  <div class="kpi-grid">
    <Card v-for="card in cards" :key="card.key" class="kpi-card" :class="card.color" @click="emit('card-click', card.key)">
      <template #content>
        <div class="kpi-row">
          <span class="kpi-icon">{{ card.icon }}</span>
          <div class="kpi-body">
            <span class="kpi-label">{{ card.label }}</span>
            <span class="kpi-value" :class="card.color">{{ card.value }}</span>
            <span class="kpi-sub">{{ card.sub }}</span>
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
  kpis: { type: Object, required: true },
})

const emit = defineEmits(['card-click'])

const fu = computed(() => props.kpis.fleetUtilization || { assigned: 0, total: 0 })

const cards = computed(() => [
  { key: 'active', icon: '🚛', label: 'Active Loads', value: props.kpis.activeLoads, sub: 'Currently in progress', color: 'accent' },
  { key: 'unassigned', icon: '⚠️', label: 'Unassigned', value: props.kpis.unassignedLoads, sub: 'Waiting for dispatch', color: 'danger' },
  { key: 'completed', icon: '✅', label: 'Completed', value: props.kpis.completedThisMonth, sub: `${props.kpis.completedThisWeek} this week`, color: 'blue' },
  { key: 'fleet', icon: '🚐', label: 'Fleet Utilization', value: `${fu.value.assigned}/${fu.value.total}`, sub: `${fu.value.total ? Math.round((fu.value.assigned / fu.value.total) * 100) : 0}% active`, color: 'amber' },
])
</script>

<style scoped>
.kpi-grid {
  display: grid;
  grid-template-columns: repeat(4, 1fr);
  gap: 1rem;
  margin-bottom: 1rem;
}

.kpi-card { cursor: pointer; transition: transform 0.15s, box-shadow 0.15s; border-left: 3px solid transparent; }
.kpi-card:hover { transform: translateY(-1px); box-shadow: 0 4px 12px rgba(0,0,0,0.1); }
.kpi-card.accent { border-left-color: var(--accent); }
.kpi-card.danger { border-left-color: var(--danger); }
.kpi-card.blue { border-left-color: var(--blue); }
.kpi-card.amber { border-left-color: var(--amber); }

:deep(.p-card-body) { padding: 1rem 1.25rem; }
:deep(.p-card-content) { padding: 0; }

.kpi-row { display: flex; align-items: flex-start; gap: 1rem; }
.kpi-icon { font-size: 1.4rem; line-height: 1; flex-shrink: 0; }
.kpi-body { display: flex; flex-direction: column; gap: 0.1rem; }
.kpi-label { font-size: 0.72rem; font-weight: 600; text-transform: uppercase; letter-spacing: 0.05em; color: var(--text-dim); }
.kpi-value { font-size: 1.75rem; font-weight: 700; line-height: 1.15; font-family: 'JetBrains Mono', monospace; }
.kpi-value.accent { color: var(--accent); }
.kpi-value.danger { color: var(--danger); }
.kpi-value.blue { color: var(--blue); }
.kpi-value.amber { color: var(--amber); }
.kpi-sub { font-size: 0.75rem; color: var(--text-dim); }

@media (max-width: 900px) { .kpi-grid { grid-template-columns: repeat(2, 1fr); } }
</style>
