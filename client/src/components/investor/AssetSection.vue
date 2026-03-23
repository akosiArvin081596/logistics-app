<template>
  <div class="section">
    <div class="section-title">
      <div class="section-icon" style="background: var(--blue-dim); color: var(--blue);">&#9679;</div>
      Asset Security Dashboard
    </div>

    <div class="asset-grid">
      <div class="asset-item">
        <div class="asset-label">Purchase Price</div>
        <div class="asset-value">{{ fmt(asset.purchasePrice) }}</div>
      </div>
      <div class="asset-item">
        <div class="asset-label">Current Market Value</div>
        <div class="asset-value" style="color: var(--accent);">{{ fmt(asset.currentValue) }}</div>
      </div>
      <div class="asset-item">
        <div class="asset-label">Title Status</div>
        <div class="asset-value title-status">{{ asset.titleStatus }}</div>
      </div>
      <div class="asset-item">
        <div class="asset-label">Fleet Size</div>
        <div class="asset-value">{{ asset.totalTrucks }}</div>
      </div>
    </div>

    <div class="dep-bar-container">
      <div class="dep-bar-label">
        <span>Depreciation ({{ asset.depreciationYears }}yr schedule)</span>
        <span>{{ depPct }}% depreciated &middot; {{ fmt(asset.annualDepreciation) }}/yr</span>
      </div>
      <div class="dep-bar">
        <div class="dep-bar-fill" :style="{ width: depPct + '%', background: 'var(--amber)' }"></div>
      </div>
    </div>
  </div>
</template>

<script setup>
import { computed } from 'vue'

const props = defineProps({
  asset: { type: Object, required: true },
  config: { type: Object, default: null },
})

const depPct = computed(() => {
  const { purchasePrice, currentValue } = props.asset
  if (!purchasePrice) return 0
  return Math.round(((purchasePrice - currentValue) / purchasePrice) * 100)
})

function fmt(n) {
  return '$' + Number(n || 0).toLocaleString('en-US')
}
</script>

<style scoped>
.section {
  background: var(--surface);
  border: 1px solid var(--border);
  border-radius: var(--radius);
  padding: 1.25rem;
  margin-bottom: 1.25rem;
}

.section-title {
  font-size: 0.95rem;
  font-weight: 700;
  margin-bottom: 1rem;
  display: flex;
  align-items: center;
  gap: 0.5rem;
}

.section-icon {
  width: 28px;
  height: 28px;
  border-radius: 8px;
  display: flex;
  align-items: center;
  justify-content: center;
  font-size: 0.9rem;
}

.asset-grid {
  display: grid;
  grid-template-columns: 1fr 1fr;
  gap: 1rem;
}

.asset-item {
  padding: 0.85rem;
  border: 1px solid var(--border);
  border-radius: 8px;
  text-align: center;
}

.asset-label {
  font-size: 0.72rem;
  color: var(--text-dim);
  font-weight: 600;
  margin-bottom: 0.3rem;
}

.asset-value {
  font-family: 'JetBrains Mono', monospace;
  font-size: 1.1rem;
  font-weight: 700;
}

.title-status {
  color: var(--blue);
  font-size: 0.95rem;
}

.dep-bar-container {
  margin-top: 1rem;
}

.dep-bar-label {
  display: flex;
  justify-content: space-between;
  font-size: 0.75rem;
  color: var(--text-dim);
  margin-bottom: 0.3rem;
}

.dep-bar {
  height: 10px;
  background: var(--border);
  border-radius: 5px;
  overflow: hidden;
}

.dep-bar-fill {
  height: 100%;
  border-radius: 5px;
  transition: width 0.5s;
}
</style>
