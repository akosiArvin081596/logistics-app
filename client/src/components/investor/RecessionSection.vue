<template>
  <div class="section">
    <div class="section-title">
      <div class="section-icon" style="background: var(--accent-dim); color: var(--accent);">&#9733;</div>
      Recession-Proof Metrics
    </div>

    <div class="kpi-grid">
      <div class="kpi-card accent">
        <div class="kpi-label">Blue-Chip Contract Share</div>
        <div class="kpi-value">{{ recessionProof.blueChipPct }}%</div>
        <div class="kpi-sub">{{ recessionProof.blueChipJobs }} of {{ recessionProof.totalJobs }} loads</div>
      </div>
      <div class="kpi-card blue">
        <div class="kpi-label">Total Broker Partners</div>
        <div class="kpi-value">{{ brokers.length }}</div>
        <div class="kpi-sub">top partners by volume</div>
      </div>
    </div>

    <table class="broker-table">
      <thead>
        <tr>
          <th>Broker / Shipper</th>
          <th>Loads</th>
          <th>Volume</th>
          <th>Type</th>
        </tr>
      </thead>
      <tbody>
        <tr v-for="b in brokers" :key="b.name">
          <td>{{ b.name }}</td>
          <td class="broker-count">{{ b.count }}</td>
          <td>
            <div class="vol-bar">
              <div
                class="vol-bar-fill"
                :style="{
                  width: volPct(b.count) + '%',
                  background: b.isBlueChip ? 'var(--accent)' : undefined,
                }"
              ></div>
            </div>
          </td>
          <td>
            <span :class="['chip-badge', b.isBlueChip ? 'chip-blue' : 'chip-default']">
              {{ b.isBlueChip ? 'Blue-Chip' : 'Standard' }}
            </span>
          </td>
        </tr>
      </tbody>
    </table>
  </div>
</template>

<script setup>
import { computed } from 'vue'

const props = defineProps({
  recessionProof: { type: Object, required: true },
})

const brokers = computed(() => props.recessionProof.topBrokers || [])

const maxBrokerCount = computed(() =>
  Math.max(...brokers.value.map((b) => b.count), 1)
)

function volPct(count) {
  return (count / maxBrokerCount.value) * 100
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

.kpi-grid {
  display: grid;
  grid-template-columns: repeat(auto-fit, minmax(180px, 1fr));
  gap: 1rem;
  margin-bottom: 1rem;
}

.kpi-card {
  padding: 1rem;
  border: 1px solid var(--border);
  border-radius: var(--radius);
  text-align: center;
}

.kpi-card.accent {
  border-color: var(--accent);
}
.kpi-card.accent .kpi-value {
  color: var(--accent);
}
.kpi-card.blue {
  border-color: var(--blue);
}
.kpi-card.blue .kpi-value {
  color: var(--blue);
}

.kpi-label {
  font-size: 0.72rem;
  font-weight: 600;
  color: var(--text-dim);
  text-transform: uppercase;
  letter-spacing: 0.04em;
  margin-bottom: 0.4rem;
}

.kpi-value {
  font-family: 'JetBrains Mono', monospace;
  font-size: 1.5rem;
  font-weight: 700;
}

.kpi-sub {
  font-size: 0.72rem;
  color: var(--text-dim);
  margin-top: 0.2rem;
}

.broker-table {
  width: 100%;
  border-collapse: collapse;
  font-size: 0.82rem;
}

.broker-table th {
  text-align: left;
  padding: 0.5rem 0.4rem;
  font-weight: 600;
  color: var(--text-dim);
  border-bottom: 2px solid var(--border);
  font-size: 0.72rem;
  text-transform: uppercase;
  letter-spacing: 0.04em;
}

.broker-table td {
  padding: 0.5rem 0.4rem;
  border-bottom: 1px solid var(--bg);
}

.broker-table tr:last-child td {
  border-bottom: none;
}

.broker-count {
  font-family: 'JetBrains Mono', monospace;
  font-weight: 600;
}

.chip-badge {
  display: inline-block;
  padding: 0.15rem 0.5rem;
  border-radius: 12px;
  font-size: 0.65rem;
  font-weight: 600;
  font-family: 'JetBrains Mono', monospace;
}

.chip-blue {
  background: var(--blue-dim);
  color: var(--blue);
}

.chip-default {
  background: var(--bg);
  color: var(--text-dim);
}

.vol-bar {
  height: 6px;
  background: var(--border);
  border-radius: 3px;
  overflow: hidden;
  min-width: 80px;
}

.vol-bar-fill {
  height: 100%;
  background: var(--blue);
  border-radius: 3px;
}
</style>
