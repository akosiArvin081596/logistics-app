<template>
  <div class="grid grid-cols-3 gap-3 mb-3">
    <div v-for="card in cards" :key="card.key" class="bg-white/5 border border-white/10 rounded-xl px-4 py-3 flex items-center gap-3">
      <div class="text-gray-400">{{ card.icon }}</div>
      <div>
        <div class="text-[0.68rem] font-semibold uppercase tracking-wide text-gray-400">{{ card.label }}</div>
        <div class="text-xl font-bold font-mono text-white">{{ card.value }}</div>
      </div>
    </div>
  </div>
</template>

<script setup>
import { computed } from 'vue'

const props = defineProps({ revenue: { type: Object, required: true } })

function fmt(n) { return '$' + Number(n || 0).toLocaleString('en-US', { maximumFractionDigits: 0 }) }

const cards = computed(() => [
  { key: 'total', icon: '$', label: 'Total Revenue', value: fmt(props.revenue.total) },
  { key: 'paid', icon: '✓', label: 'Paid', value: fmt(props.revenue.paid) },
  { key: 'pending', icon: '◔', label: 'Pending', value: fmt(props.revenue.pending) },
])
</script>
