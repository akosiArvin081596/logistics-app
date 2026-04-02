<template>
  <div class="grid grid-cols-3 gap-3 mb-3">
    <div v-for="card in cards" :key="card.key"
      class="bg-white rounded-xl px-5 py-4 flex items-center gap-4 border border-gray-100 shadow-[0_1px_3px_rgba(0,0,0,0.06)]">
      <div class="w-9 h-9 rounded-lg flex items-center justify-center text-base shrink-0" :class="card.bg">{{ card.icon }}</div>
      <div>
        <div class="text-[11px] font-semibold uppercase tracking-wider text-gray-400">{{ card.label }}</div>
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
  { key: 'total', icon: '$', label: 'Total Revenue', value: fmt(props.revenue.total), bg: 'bg-gray-100 text-gray-500' },
  { key: 'paid', icon: '✓', label: 'Paid', value: fmt(props.revenue.paid), bg: 'bg-emerald-50 text-emerald-500' },
  { key: 'pending', icon: '◔', label: 'Pending', value: fmt(props.revenue.pending), bg: 'bg-amber-50 text-amber-500' },
])
</script>
