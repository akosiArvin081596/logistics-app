<template>
  <div class="kpi-grid">
    <div v-for="card in cards" :key="card.key" class="kpi-card" @click="emit('card-click', card.key)">
      <i :class="['kpi-icon pi', card.icon]"></i>
      <div class="kpi-body">
        <span class="kpi-label">{{ card.label }}</span>
        <span class="kpi-value">{{ card.value }}</span>
        <span class="kpi-sub">{{ card.sub }}</span>
      </div>
    </div>
  </div>
</template>

<script setup>
import { computed } from 'vue'

const props = defineProps({
  kpis: { type: Object, required: true },
})

const emit = defineEmits(['card-click'])

const fu = computed(() => props.kpis.fleetUtilization || { assigned: 0, total: 0 })

const cards = computed(() => [
  { key: 'active', icon: 'pi-truck', label: 'Active Loads', value: props.kpis.activeLoads, sub: 'Currently in progress' },
  { key: 'unassigned', icon: 'pi-exclamation-circle', label: 'Unassigned', value: props.kpis.unassignedLoads, sub: 'Waiting for dispatch' },
  { key: 'completed', icon: 'pi-check-circle', label: 'Completed', value: props.kpis.completedThisMonth, sub: `${props.kpis.completedThisWeek} this week` },
  { key: 'fleet', icon: 'pi-users', label: 'Fleet Utilization', value: `${fu.value.assigned}/${fu.value.total}`, sub: `${fu.value.total ? Math.round((fu.value.assigned / fu.value.total) * 100) : 0}% active` },
])
</script>

<style scoped>
.kpi-grid {
  display: grid;
  grid-template-columns: repeat(4, 1fr);
  gap: 0.75rem;
  margin-bottom: 0.75rem;
}

.kpi-card {
  background: var(--surface);
  border: 1px solid var(--border);
  border-radius: 10px;
  padding: 1rem 1.15rem;
  display: flex;
  align-items: flex-start;
  gap: 0.85rem;
  cursor: pointer;
  transition: border-color 0.15s;
}
.kpi-card:hover { border-color: var(--accent); }

.kpi-icon { font-size: 1.2rem; color: var(--text-dim); margin-top: 0.15rem; }
.kpi-body { display: flex; flex-direction: column; gap: 0.05rem; }
.kpi-label { font-size: 0.68rem; font-weight: 600; text-transform: uppercase; letter-spacing: 0.05em; color: var(--text-dim); }
.kpi-value { font-size: 1.6rem; font-weight: 700; line-height: 1.15; font-family: 'JetBrains Mono', monospace; color: var(--text); }
.kpi-sub { font-size: 0.72rem; color: var(--text-dim); }

@media (max-width: 900px) { .kpi-grid { grid-template-columns: repeat(2, 1fr); } }
</style>
