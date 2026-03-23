<template>
  <div class="kpi-grid">
    <div class="kpi-card accent">
      <div class="kpi-label">Active Loads</div>
      <div class="kpi-value">{{ kpis.activeLoads }}</div>
      <div class="kpi-sub">Currently in progress</div>
    </div>
    <div class="kpi-card danger">
      <div class="kpi-label">Unassigned</div>
      <div class="kpi-value">{{ kpis.unassignedLoads }}</div>
      <div class="kpi-sub">Waiting for dispatch</div>
    </div>
    <div class="kpi-card blue">
      <div class="kpi-label">Completed</div>
      <div class="kpi-value">{{ kpis.completedThisMonth }}</div>
      <div class="kpi-sub">{{ kpis.completedThisWeek }} this week</div>
    </div>
    <div class="kpi-card amber">
      <div class="kpi-label">Fleet Utilization</div>
      <div class="kpi-value">{{ fu.assigned }}/{{ fu.total }}</div>
      <div class="kpi-sub">{{ fu.total ? Math.round((fu.assigned / fu.total) * 100) : 0 }}% active</div>
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
