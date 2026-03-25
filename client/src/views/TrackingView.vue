<template>
  <div class="tracking-page admin-page">
    <div class="page-header">
      <h2>Live Tracking</h2>
    </div>
    <div class="tracking-fill">
      <TrackingMap :visible="true" />
    </div>
  </div>
</template>

<script setup>
import TrackingMap from '../components/dashboard/TrackingMap.vue'
</script>

<style scoped>
.tracking-page { overflow: hidden; }
.tracking-fill {
  flex: 1;
  min-height: 0;
  background: var(--surface);
  border: 1px solid var(--border);
  border-radius: var(--radius);
  overflow: hidden;
}
</style>
