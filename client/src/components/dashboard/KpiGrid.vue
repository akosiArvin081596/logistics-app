<template>
  <div class="kpi-grid">
    <Card v-for="card in cards" :key="card.key" :class="['kpi-card', card.theme]" @click="emit('card-click', card.key)">
      <CardContent class="flex items-center gap-4" style="padding:1rem 1.25rem;">
        <div :class="['kpi-icon', card.iconTheme]">{{ card.icon }}</div>
        <div class="kpi-info">
          <div class="kpi-label">{{ card.label }}</div>
          <div class="kpi-value">{{ card.value }}</div>
          <div class="kpi-sub">{{ card.sub }}</div>
        </div>
      </CardContent>
    </Card>
  </div>
</template>

<script setup>
import { computed } from 'vue'
import { Card, CardContent } from '@/components/ui/card'

const props = defineProps({ kpis: { type: Object, required: true }, completedTotal: { type: Number, default: null } })
const emit = defineEmits(['card-click'])
const fu = computed(() => props.kpis.fleetUtilization || { assigned: 0, total: 0 })
const cards = computed(() => [
  { key: 'active', icon: '●', label: 'Active Loads', value: props.kpis.activeLoads, sub: 'Currently in progress', theme: 'kpi-blue', iconTheme: 'kpi-icon-blue' },
  { key: 'unassigned', icon: '!', label: 'Unassigned', value: props.kpis.unassignedLoads, sub: 'Waiting for dispatch', theme: 'kpi-amber', iconTheme: 'kpi-icon-amber' },
  { key: 'completed', icon: '✓', label: 'Completed', value: props.completedTotal ?? props.kpis.completedThisMonth, sub: `${props.kpis.completedThisWeek} this week`, theme: 'kpi-emerald', iconTheme: 'kpi-icon-emerald' },
  { key: 'fleet', icon: '⊞', label: 'Fleet', value: `${fu.value.assigned}/${fu.value.total}`, sub: `${fu.value.total ? Math.round((fu.value.assigned / fu.value.total) * 100) : 0}% active`, theme: 'kpi-violet', iconTheme: 'kpi-icon-violet' },
])
</script>
