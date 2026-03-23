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

<style scoped>
.fleet-grid {
  display: grid;
  grid-template-columns: repeat(auto-fill, minmax(260px, 1fr));
  gap: 1rem;
  padding: 1rem 0;
}

.fleet-card {
  border: 1px solid var(--border);
  border-radius: 0.5rem;
  padding: 1rem;
  background: var(--surface);
}

.driver-name {
  font-weight: 600;
  font-size: 1rem;
  margin-bottom: 0.15rem;
}

.truck-id {
  font-size: 0.85rem;
  color: var(--text-muted);
  margin-bottom: 0.5rem;
}

.fleet-meta {
  display: flex;
  align-items: center;
  gap: 0.75rem;
  font-size: 0.85rem;
}

.driver-status {
  padding: 0.15rem 0.5rem;
  border-radius: 9999px;
  font-weight: 500;
  font-size: 0.8rem;
}

.driver-status.available {
  background: #dcfce7;
  color: #166534;
}

.driver-status.on-load {
  background: #dbeafe;
  color: #1e40af;
}

.fleet-stat {
  color: var(--text-muted);
}

.load-id {
  margin-top: 0.35rem;
  font-size: 0.85rem;
  color: var(--text-muted);
}
</style>
