<template>
  <div class="grid grid-cols-4 gap-4 mb-4 max-[900px]:grid-cols-2">
    <div v-for="card in cards" :key="card.key"
      :class="[card.cardBg, card.borderAccent, 'rounded-xl p-5 flex items-start gap-4 cursor-pointer shadow-[0_1px_3px_rgba(0,0,0,0.04),0_6px_16px_rgba(0,0,0,0.03)] hover:shadow-[0_2px_8px_rgba(0,0,0,0.06),0_12px_28px_rgba(0,0,0,0.05)] hover:-translate-y-0.5 transition-all duration-200']"
      @click="emit('card-click', card.key)">
      <div :class="[card.iconBg, 'w-11 h-11 rounded-xl flex items-center justify-center text-lg shrink-0 shadow-sm']">{{ card.icon }}</div>
      <div class="min-w-0">
        <div class="text-[11px] font-semibold uppercase tracking-wider text-gray-500 mb-1.5">{{ card.label }}</div>
        <div class="text-[1.75rem] font-bold leading-none text-gray-800" style="font-family:'JetBrains Mono',monospace;">{{ card.value }}</div>
        <div class="text-[11px] text-gray-400 mt-1.5">{{ card.sub }}</div>
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
  { key: 'active', icon: '●', label: 'Active Loads', value: props.kpis.activeLoads, sub: 'Currently in progress',
    cardBg: 'bg-gradient-to-br from-blue-50/80 to-white border border-blue-100/80',
    borderAccent: 'border-l-[3px] border-l-blue-500',
    iconBg: 'bg-blue-100 text-blue-600' },
  { key: 'unassigned', icon: '!', label: 'Unassigned', value: props.kpis.unassignedLoads, sub: 'Waiting for dispatch',
    cardBg: 'bg-gradient-to-br from-amber-50/80 to-white border border-amber-100/80',
    borderAccent: 'border-l-[3px] border-l-amber-500',
    iconBg: 'bg-amber-100 text-amber-600' },
  { key: 'completed', icon: '✓', label: 'Completed', value: props.kpis.completedThisMonth, sub: `${props.kpis.completedThisWeek} this week`,
    cardBg: 'bg-gradient-to-br from-emerald-50/80 to-white border border-emerald-100/80',
    borderAccent: 'border-l-[3px] border-l-emerald-500',
    iconBg: 'bg-emerald-100 text-emerald-600' },
  { key: 'fleet', icon: '⊞', label: 'Fleet', value: `${fu.value.assigned}/${fu.value.total}`, sub: `${fu.value.total ? Math.round((fu.value.assigned / fu.value.total) * 100) : 0}% active`,
    cardBg: 'bg-gradient-to-br from-violet-50/80 to-white border border-violet-100/80',
    borderAccent: 'border-l-[3px] border-l-violet-500',
    iconBg: 'bg-violet-100 text-violet-600' },
])
</script>
