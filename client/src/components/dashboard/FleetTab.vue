<template>
  <div class="table-scroll">
    <div v-if="fleet.length > 0" class="fleet-grid">
      <div v-for="f in fleet" :key="f.Driver" class="fleet-card">
        <div class="driver-name">{{ f.Driver || 'Unknown' }}</div>
        <div class="truck-id">{{ f.Truck || 'No truck assigned' }}</div>
        <div class="fleet-meta">
          <span :class="['driver-status', f.Status === 'On Load' ? 'on-load' : 'available']">
            {{ f.Status }}
          </span>
          <span class="fleet-stat">{{ f.CompletedLoads }} completed</span>
        </div>
        <div v-if="f.CurrentLoad" class="load-id">Load: {{ f.CurrentLoad }}</div>
        <div v-if="f.Phone" class="fleet-stat" style="margin-top:0.35rem">{{ f.Phone }}</div>
      </div>
    </div>
    <EmptyState v-else>No carriers found.</EmptyState>
  </div>
</template>

<script setup>
import EmptyState from '../shared/EmptyState.vue'

defineProps({
  fleet: { type: Array, required: true },
})
</script>
