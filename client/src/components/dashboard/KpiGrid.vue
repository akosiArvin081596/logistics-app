<template>
  <div class="grid grid-cols-4 gap-3 mb-3">
    <div v-for="card in cards" :key="card.key"
      class="bg-white/5 border border-white/10 rounded-xl p-4 flex items-start gap-3 cursor-pointer hover:border-sky-400/40 transition"
      @click="emit('card-click', card.key)">
      <div class="text-gray-400 text-lg mt-0.5">{{ card.icon }}</div>
      <div>
        <div class="text-[0.68rem] font-semibold uppercase tracking-wide text-gray-400">{{ card.label }}</div>
        <div class="text-2xl font-bold font-mono text-white leading-tight">{{ card.value }}</div>
        <div class="text-xs text-gray-500">{{ card.sub }}</div>
      </div>
    </div>
  </div>
</template>

<script setup>
import { computed } from 'vue'

const props = defineProps({ kpis: { type: Object, required: true } })
const emit = defineEmits(['card-click'])
const fu = computed(() => props.kpis.fleetUtilization || { assigned: 0, total: 0 })

const cards = computed(() => [
  { key: 'active', icon: '●', label: 'Active Loads', value: props.kpis.activeLoads, sub: 'Currently in progress' },
  { key: 'unassigned', icon: '○', label: 'Unassigned', value: props.kpis.unassignedLoads, sub: 'Waiting for dispatch' },
  { key: 'completed', icon: '✓', label: 'Completed', value: props.kpis.completedThisMonth, sub: `${props.kpis.completedThisWeek} this week` },
  { key: 'fleet', icon: '◈', label: 'Fleet Utilization', value: `${fu.value.assigned}/${fu.value.total}`, sub: `${fu.value.total ? Math.round((fu.value.assigned / fu.value.total) * 100) : 0}% active` },
])
</script>
