<template>
  <div class="grid grid-cols-4 gap-3 mb-3 max-[900px]:grid-cols-2">
    <div v-for="card in cards" :key="card.key"
      class="bg-white rounded-xl p-5 flex items-start gap-4 cursor-pointer border border-gray-100 shadow-[0_1px_3px_rgba(0,0,0,0.06)] hover:shadow-md hover:border-sky-200 transition-all"
      @click="emit('card-click', card.key)">
      <div class="w-10 h-10 rounded-lg bg-sky-50 text-sky-500 flex items-center justify-center text-lg shrink-0">{{ card.icon }}</div>
      <div class="min-w-0">
        <div class="text-[11px] font-semibold uppercase tracking-wider text-gray-400 mb-1">{{ card.label }}</div>
        <div class="text-[1.6rem] font-bold leading-none text-gray-800" style="font-family:'JetBrains Mono',monospace;">{{ card.value }}</div>
        <div class="text-[11px] text-gray-400 mt-1">{{ card.sub }}</div>
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
  { key: 'unassigned', icon: '!', label: 'Unassigned', value: props.kpis.unassignedLoads, sub: 'Waiting for dispatch' },
  { key: 'completed', icon: '✓', label: 'Completed', value: props.kpis.completedThisMonth, sub: `${props.kpis.completedThisWeek} this week` },
  { key: 'fleet', icon: '⊞', label: 'Fleet', value: `${fu.value.assigned}/${fu.value.total}`, sub: `${fu.value.total ? Math.round((fu.value.assigned / fu.value.total) * 100) : 0}% active` },
])
</script>
