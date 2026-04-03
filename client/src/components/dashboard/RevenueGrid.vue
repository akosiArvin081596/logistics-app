<template>
  <div class="kpi-grid" style="grid-template-columns:repeat(3,1fr);">
    <Card v-for="card in cards" :key="card.key" class="kpi-card" style="border:1px solid #e8edf2;">
      <CardContent class="flex items-center gap-4" style="padding:1rem 1.25rem;">
        <div :class="['kpi-icon', card.iconTheme]">{{ card.icon }}</div>
        <div class="kpi-info">
          <div class="kpi-label">{{ card.label }}</div>
          <div class="kpi-value">{{ card.value }}</div>
        </div>
      </CardContent>
    </Card>
  </div>
</template>

<script setup>
import { computed } from 'vue'
import { Card, CardContent } from '@/components/ui/card'

const props = defineProps({ revenue: { type: Object, required: true } })
function fmt(n) { return '$' + Number(n || 0).toLocaleString('en-US', { maximumFractionDigits: 0 }) }
const cards = computed(() => [
  { key: 'total', icon: '$', label: 'Total Revenue', value: fmt(props.revenue.total), iconTheme: 'kpi-icon-blue' },
  { key: 'paid', icon: '✓', label: 'Paid', value: fmt(props.revenue.paid), iconTheme: 'kpi-icon-emerald' },
  { key: 'pending', icon: '◔', label: 'Pending', value: fmt(props.revenue.pending), iconTheme: 'kpi-icon-amber' },
])
</script>
