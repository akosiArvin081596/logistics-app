<template>
  <div class="section">
    <div class="section-title">
      <div class="section-icon" style="background: var(--amber-dim); color: var(--amber);">&#128203;</div>
      Per-Truck Breakdown
    </div>

    <div v-if="trucks.length === 0" class="empty-state">No trucks in database yet.</div>

    <table v-else class="fleet-table">
      <thead>
        <tr>
          <th></th>
          <th>Unit</th>
          <th>Make / Model</th>
          <th>Status</th>
          <th>Driver</th>
          <th>Miles</th>
          <th>Est. Revenue</th>
          <th>ROI</th>
        </tr>
      </thead>
      <tbody>
        <tr v-for="t in trucksWithROI" :key="t.id">
          <td class="photo-cell">
            <img v-if="t.Photo" :src="t.Photo" class="truck-thumb" :alt="t.UnitNumber" />
            <div v-else class="truck-thumb-placeholder">&#128665;</div>
          </td>
          <td class="unit-num">{{ t.UnitNumber }}</td>
          <td>{{ [t.Make, t.Model].filter(Boolean).join(' ') || '\u2014' }}</td>
          <td>
            <span :class="['status-badge', statusClass(t.Status)]">{{ t.Status }}</span>
          </td>
          <td :style="{ color: t.AssignedDriver ? 'var(--text)' : 'var(--text-dim)' }">
            {{ t.AssignedDriver || '\u2014' }}
          </td>
          <td class="mono">{{ (t.totalMiles || 0).toLocaleString() }}</td>
          <td class="mono">{{ fmt(t.estRevenue) }}</td>
          <td>
            <span :class="['roi-badge', t.roi >= 0 ? 'positive' : 'negative']">
              {{ t.roi >= 0 ? '+' : '' }}{{ t.roi.toFixed(1) }}%
            </span>
          </td>
        </tr>
      </tbody>
      <tfoot>
        <tr>
          <td colspan="6" class="total-label">Fleet Total</td>
          <td class="mono total-val">{{ fmt(totalEstRevenue) }}</td>
          <td>
            <span :class="['roi-badge', fleetROI >= 0 ? 'positive' : 'negative']">
              {{ fleetROI >= 0 ? '+' : '' }}{{ fleetROI.toFixed(1) }}%
            </span>
          </td>
        </tr>
      </tfoot>
    </table>
  </div>
</template>

<script setup>
import { computed } from 'vue'

const props = defineProps({
  trucks: { type: Array, default: () => [] },
  asset: { type: Object, default: () => ({}) },
  production: { type: Object, default: () => ({}) },
})

const trucksWithROI = computed(() => {
  const perTruckData = props.production?.perTruckData || {}
  const grossRevenue = props.production?.totalRevenue || 0
  const purchasePrice = props.asset?.purchasePrice || 58000

  return props.trucks.map(t => {
    const unitKey = t.UnitNumber || t.unit_number || ''
    const perUnit = perTruckData[unitKey]
    const estRevenue = perUnit?.estAnnualRevenue ?? 0
    const roi = purchasePrice > 0 && grossRevenue > 0
      ? (estRevenue / grossRevenue) * 100
      : 0
    const totalMiles = perUnit?.totalMiles ?? 0
    return { ...t, estRevenue, roi, totalMiles }
  })
})

const totalEstRevenue = computed(() => trucksWithROI.value.reduce((s, t) => s + t.estRevenue, 0))
// RFD-14: Fleet Total ROI = sum(estAnnualRevenue) / totalGrossRevenue
const fleetROI = computed(() => {
  const grossRevenue = props.production?.totalRevenue || 0
  if (grossRevenue === 0) return 0
  return (totalEstRevenue.value / grossRevenue) * 100
})

function fmt(n) {
  return '$' + Number(n || 0).toLocaleString('en-US', { maximumFractionDigits: 0 })
}

function statusClass(status) {
  if (status === 'Active') return 'status-active'
  if (status === 'Inactive') return 'status-inactive'
  return 'status-maintenance'
}
</script>

<style scoped>
.section {
  background: var(--surface); border: 1px solid var(--border);
  border-radius: var(--radius); padding: 1.25rem; margin-bottom: 1.25rem;
}
.section-title {
  font-size: 0.95rem; font-weight: 700; margin-bottom: 1rem;
  display: flex; align-items: center; gap: 0.5rem;
}
.section-icon {
  width: 28px; height: 28px; border-radius: 8px;
  display: flex; align-items: center; justify-content: center; font-size: 0.9rem;
}
.empty-state { text-align: center; color: var(--text-dim); font-size: 0.85rem; padding: 2rem 0; }

.fleet-table {
  width: 100%; border-collapse: separate; border-spacing: 0;
  font-size: 0.82rem;
}
.fleet-table th {
  text-align: left; padding: 0.6rem 0.5rem; font-weight: 600;
  color: var(--text-dim); border-bottom: 2px solid var(--border);
  font-size: 0.68rem; text-transform: uppercase; letter-spacing: 0.06em;
}
.fleet-table td {
  padding: 0.65rem 0.5rem; border-bottom: 1px solid var(--bg); vertical-align: middle;
}
.fleet-table tbody tr:hover { background: var(--bg); }
.fleet-table tfoot td {
  padding: 0.75rem 0.5rem; border-top: 2px solid var(--border);
  font-weight: 700;
}

.photo-cell { width: 42px; padding: 0.3rem 0.25rem; }
.truck-thumb {
  width: 38px; height: 28px; object-fit: cover;
  border-radius: 4px; display: block;
}
.truck-thumb-placeholder {
  width: 38px; height: 28px; border-radius: 4px;
  background: var(--bg); display: flex; align-items: center;
  justify-content: center; font-size: 1rem; color: var(--text-dim);
}
.unit-num { font-family: 'JetBrains Mono', monospace; font-weight: 600; }
.mono { font-family: 'JetBrains Mono', monospace; }
.total-label { text-align: right; }
.total-val { color: var(--accent); }

.status-badge {
  display: inline-flex; padding: 0.2rem 0.6rem; border-radius: 12px;
  font-size: 0.68rem; font-weight: 600; font-family: 'JetBrains Mono', monospace;
}
.status-active { background: var(--accent-dim); color: var(--accent); }
.status-inactive { background: var(--bg); color: var(--text-dim); }
.status-maintenance { background: var(--amber-dim); color: var(--amber); }

.roi-badge {
  display: inline-flex; padding: 0.15rem 0.5rem; border-radius: 8px;
  font-size: 0.72rem; font-weight: 700; font-family: 'JetBrains Mono', monospace;
}
.roi-badge.positive { background: var(--accent-dim); color: var(--accent); }
.roi-badge.negative { background: var(--danger-dim); color: var(--danger); }
</style>
