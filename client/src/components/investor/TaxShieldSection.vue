<template>
  <div class="section">
    <div class="section-title">
      <div class="section-icon" style="background: var(--amber-dim); color: var(--amber);">&#9670;</div>
      Tax Shield Tracker
    </div>

    <div class="progress-container">
      <div class="progress-ring">
        <svg viewBox="0 0 120 120">
          <circle class="ring-bg" cx="60" cy="60" r="50" />
          <circle
            class="ring-fill"
            cx="60"
            cy="60"
            r="50"
            :stroke-dasharray="circumference"
            :stroke-dashoffset="dashOffset"
          />
        </svg>
        <div class="ring-text">{{ taxShield.writeOffPct }}%</div>
      </div>

      <div class="progress-details">
        <div class="progress-row">
          <span class="progress-label">Year 1 Write-Off (Sec. 179 + Bonus)</span>
          <span class="progress-value" style="color: var(--accent);">{{ fmt(taxShield.section179) }}</span>
        </div>
        <div class="progress-row">
          <span class="progress-label">Purchase Price</span>
          <span class="progress-value">{{ fmt(purchasePrice) }}</span>
        </div>
        <div class="progress-row">
          <span class="progress-label">At-Risk Capital Remaining</span>
          <span class="progress-value" style="color: var(--danger);">{{ fmt(taxShield.atRiskCapital) }}</span>
        </div>
        <div class="progress-row">
          <span class="progress-label">Tax Shield Coverage</span>
          <span class="progress-value" style="color: var(--accent);">{{ taxShield.writeOffPct }}%</span>
        </div>
      </div>
    </div>
  </div>
</template>

<script setup>
import { computed } from 'vue'

const props = defineProps({
  taxShield: { type: Object, required: true },
  config: { type: Object, default: null },
})

const circumference = 2 * Math.PI * 50

const dashOffset = computed(() => {
  const pct = props.taxShield.writeOffPct || 0
  return circumference - (pct / 100) * circumference
})

const purchasePrice = computed(() => props.taxShield.purchasePrice || 0)

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

.progress-container {
  display: flex;
  align-items: center;
  gap: 1.5rem;
  flex-wrap: wrap;
}

.progress-ring {
  position: relative;
  width: 120px;
  height: 120px;
}

.progress-ring svg {
  transform: rotate(-90deg);
  width: 120px;
  height: 120px;
}

.ring-bg {
  fill: none;
  stroke: var(--border);
  stroke-width: 10;
}

.ring-fill {
  fill: none;
  stroke: var(--accent);
  stroke-width: 10;
  stroke-linecap: round;
  transition: stroke-dashoffset 0.5s;
}

.ring-text {
  position: absolute;
  inset: 0;
  display: flex;
  align-items: center;
  justify-content: center;
  font-family: 'JetBrains Mono', monospace;
  font-size: 1.3rem;
  font-weight: 700;
  color: var(--accent);
}

.progress-details {
  flex: 1;
  min-width: 200px;
}

.progress-row {
  display: flex;
  justify-content: space-between;
  padding: 0.4rem 0;
  font-size: 0.85rem;
  border-bottom: 1px solid var(--bg);
}

.progress-row:last-child {
  border-bottom: none;
}

.progress-label {
  color: var(--text-dim);
}

.progress-value {
  font-weight: 600;
  font-family: 'JetBrains Mono', monospace;
  font-size: 0.82rem;
}
</style>
