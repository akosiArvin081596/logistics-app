<template>
  <div class="grid grid-cols-3 gap-3 mb-3">
    <Card v-for="card in cards" :key="card.key" :pt="{ body: { style: 'padding: 0.85rem 1.15rem' }, content: { style: 'padding: 0' } }">
      <template #content>
        <div class="flex align-items-center gap-3">
          <i :class="['pi', card.icon]" style="font-size:1.1rem;color:var(--p-text-muted-color);"></i>
          <div class="flex flex-column">
            <span class="text-xs font-semibold text-color-secondary uppercase" style="letter-spacing:0.05em;">{{ card.label }}</span>
            <span class="text-xl font-bold font-mono text-color">{{ card.value }}</span>
          </div>
        </div>
      </template>
    </Card>
  </div>
</template>

<script setup>
import { computed } from 'vue'
import Card from 'primevue/card'

const props = defineProps({
  revenue: { type: Object, required: true },
})

function fmt(n) {
  return '$' + Number(n || 0).toLocaleString('en-US', { maximumFractionDigits: 0 })
}

const cards = computed(() => [
  { key: 'total', icon: 'pi-dollar', label: 'Total Revenue', value: fmt(props.revenue.total) },
  { key: 'paid', icon: 'pi-check', label: 'Paid', value: fmt(props.revenue.paid) },
  { key: 'pending', icon: 'pi-clock', label: 'Pending', value: fmt(props.revenue.pending) },
])
</script>

<style scoped>
.font-mono { font-family: 'JetBrains Mono', monospace; }
.grid-cols-3 { grid-template-columns: repeat(3, 1fr); }
</style>
