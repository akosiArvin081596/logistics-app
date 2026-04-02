<template>
  <div class="grid grid-cols-3 gap-4 mb-4">
    <div v-for="card in cards" :key="card.key"
      :class="[card.cardClass, 'rounded-xl px-5 py-4 flex items-center gap-4 shadow-[0_1px_3px_rgba(0,0,0,0.04),0_4px_12px_rgba(0,0,0,0.03)] transition-all duration-200 hover:shadow-[0_2px_6px_rgba(0,0,0,0.06),0_8px_20px_rgba(0,0,0,0.04)]']">
      <div :class="[card.bg, 'w-10 h-10 rounded-xl flex items-center justify-center text-base shrink-0 shadow-sm']">{{ card.icon }}</div>
      <div>
        <div class="text-[11px] font-semibold uppercase tracking-wider text-gray-500">{{ card.label }}</div>
        <div class="text-xl font-bold text-gray-800" style="font-family:'JetBrains Mono',monospace;">{{ card.value }}</div>
      </div>
    </div>
  </div>
</template>

<script setup>
import { computed } from 'vue'
const props = defineProps({ revenue: { type: Object, required: true } })
function fmt(n) { return '$' + Number(n || 0).toLocaleString('en-US', { maximumFractionDigits: 0 }) }
const cards = computed(() => [
  { key: 'total', icon: '$', label: 'Total Revenue', value: fmt(props.revenue.total),
    bg: 'bg-gray-100 text-gray-600',
    cardClass: 'bg-gradient-to-br from-gray-50 to-white border-t-[3px] border-t-gray-400 border border-gray-100' },
  { key: 'paid', icon: '✓', label: 'Paid', value: fmt(props.revenue.paid),
    bg: 'bg-emerald-100 text-emerald-600',
    cardClass: 'bg-gradient-to-br from-emerald-50/60 to-white border-t-[3px] border-t-emerald-500 border border-emerald-100/80' },
  { key: 'pending', icon: '◔', label: 'Pending', value: fmt(props.revenue.pending),
    bg: 'bg-amber-100 text-amber-600',
    cardClass: 'bg-gradient-to-br from-amber-50/60 to-white border-t-[3px] border-t-amber-500 border border-amber-100/80' },
])
</script>
