<template>
  <div class="grid grid-cols-3 gap-5 mb-6">
    <div v-for="card in cards" :key="card.key" :class="['rev-card', card.theme]">
      <div :class="['rev-icon', card.iconTheme]">{{ card.icon }}</div>
      <div>
        <div class="rev-label">{{ card.label }}</div>
        <div class="rev-value">{{ card.value }}</div>
      </div>
    </div>
  </div>
</template>

<script setup>
import { computed } from 'vue'
const props = defineProps({ revenue: { type: Object, required: true } })
function fmt(n) { return '$' + Number(n || 0).toLocaleString('en-US', { maximumFractionDigits: 0 }) }
const cards = computed(() => [
  { key: 'total', icon: '$', label: 'Total Revenue', value: fmt(props.revenue.total), theme: 'rev-gray', iconTheme: 'rev-icon-gray' },
  { key: 'paid', icon: '✓', label: 'Paid', value: fmt(props.revenue.paid), theme: 'rev-emerald', iconTheme: 'rev-icon-emerald' },
  { key: 'pending', icon: '◔', label: 'Pending', value: fmt(props.revenue.pending), theme: 'rev-amber', iconTheme: 'rev-icon-amber' },
])
</script>
