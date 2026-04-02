<template>
  <div class="grid grid-cols-4 gap-3 mb-3">
    <Card v-for="card in cards" :key="card.key" class="cursor-pointer" :pt="{ body: { style: 'padding: 1rem' }, content: { style: 'padding: 0' } }" @click="emit('card-click', card.key)">
      <template #content>
        <div class="flex align-items-start gap-3">
          <i :class="['pi', card.icon]" style="font-size:1.2rem;color:var(--p-text-muted-color);margin-top:2px;"></i>
          <div class="flex flex-column">
            <span class="text-xs font-semibold text-color-secondary uppercase" style="letter-spacing:0.05em;">{{ card.label }}</span>
            <span class="text-3xl font-bold font-mono text-color">{{ card.value }}</span>
            <span class="text-xs text-color-secondary">{{ card.sub }}</span>
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
  kpis: { type: Object, required: true },
})

const emit = defineEmits(['card-click'])

const fu = computed(() => props.kpis.fleetUtilization || { assigned: 0, total: 0 })

const cards = computed(() => [
  { key: 'active', icon: 'pi-truck', label: 'Active Loads', value: props.kpis.activeLoads, sub: 'Currently in progress' },
  { key: 'unassigned', icon: 'pi-exclamation-circle', label: 'Unassigned', value: props.kpis.unassignedLoads, sub: 'Waiting for dispatch' },
  { key: 'completed', icon: 'pi-check-circle', label: 'Completed', value: props.kpis.completedThisMonth, sub: `${props.kpis.completedThisWeek} this week` },
  { key: 'fleet', icon: 'pi-users', label: 'Fleet Utilization', value: `${fu.value.assigned}/${fu.value.total}`, sub: `${fu.value.total ? Math.round((fu.value.assigned / fu.value.total) * 100) : 0}% active` },
])
</script>

<style scoped>
.font-mono { font-family: 'JetBrains Mono', monospace; }
.grid-cols-4 { grid-template-columns: repeat(4, 1fr); }
@media (max-width: 900px) { .grid-cols-4 { grid-template-columns: repeat(2, 1fr); } }
</style>
