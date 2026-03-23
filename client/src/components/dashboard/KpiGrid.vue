<template>
  <div class="kpi-grid">
    <div class="kpi-card accent">
      <div class="kpi-icon">🚛</div>
      <div class="kpi-body">
        <div class="kpi-label">Active Loads</div>
        <div class="kpi-value accent">{{ kpis.activeLoads }}</div>
        <div class="kpi-sub">Currently in progress</div>
      </div>
    </div>
    <div class="kpi-card danger">
      <div class="kpi-icon">⚠️</div>
      <div class="kpi-body">
        <div class="kpi-label">Unassigned</div>
        <div class="kpi-value danger">{{ kpis.unassignedLoads }}</div>
        <div class="kpi-sub">Waiting for dispatch</div>
      </div>
    </div>
    <div class="kpi-card blue">
      <div class="kpi-icon">✅</div>
      <div class="kpi-body">
        <div class="kpi-label">Completed</div>
        <div class="kpi-value blue">{{ kpis.completedThisMonth }}</div>
        <div class="kpi-sub">{{ kpis.completedThisWeek }} this week</div>
      </div>
    </div>
    <div class="kpi-card amber">
      <div class="kpi-icon">🚐</div>
      <div class="kpi-body">
        <div class="kpi-label">Fleet Utilization</div>
        <div class="kpi-value amber">{{ fu.assigned }}/{{ fu.total }}</div>
        <div class="kpi-sub">{{ fu.total ? Math.round((fu.assigned / fu.total) * 100) : 0 }}% active</div>
      </div>
    </div>
  </div>
</template>

<script setup>
import { computed } from 'vue'

const props = defineProps({
  kpis: { type: Object, required: true },
})

const fu = computed(() => props.kpis.fleetUtilization || { assigned: 0, total: 0 })
</script>

<style scoped>
.kpi-grid {
  display: grid;
  grid-template-columns: repeat(4, 1fr);
  gap: 1rem;
  margin-bottom: 1rem;
}

.kpi-card {
  background: var(--surface);
  border: 1px solid var(--border);
  border-radius: var(--radius);
  padding: 1.1rem 1.25rem;
  display: flex;
  align-items: flex-start;
  gap: 1rem;
  box-shadow: 0 1px 4px rgba(0,0,0,0.05);
  border-left: 3px solid transparent;
}
.kpi-card.accent { border-left-color: var(--accent); }
.kpi-card.danger { border-left-color: var(--danger); }
.kpi-card.blue   { border-left-color: var(--blue); }
.kpi-card.amber  { border-left-color: var(--amber); }

.kpi-icon {
  font-size: 1.4rem;
  line-height: 1;
  margin-top: 0.1rem;
  flex-shrink: 0;
}

.kpi-body { display: flex; flex-direction: column; gap: 0.1rem; min-width: 0; }

.kpi-label {
  font-size: 0.72rem;
  font-weight: 600;
  text-transform: uppercase;
  letter-spacing: 0.05em;
  color: var(--text-dim);
}

.kpi-value {
  font-size: 1.75rem;
  font-weight: 700;
  line-height: 1.15;
  font-family: 'JetBrains Mono', monospace;
}
.kpi-value.accent { color: var(--accent); }
.kpi-value.danger { color: var(--danger); }
.kpi-value.blue   { color: var(--blue); }
.kpi-value.amber  { color: var(--amber); }

.kpi-sub {
  font-size: 0.75rem;
  color: var(--text-dim);
  margin-top: 0.1rem;
}

@media (max-width: 900px) {
  .kpi-grid { grid-template-columns: repeat(2, 1fr); }
}
</style>
