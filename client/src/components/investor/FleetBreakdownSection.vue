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
          <th>Loads</th>
          <th>Miles</th>
          <th>Est. Revenue</th>
          <th>ROI</th>
        </tr>
      </thead>
      <tbody>
        <template v-for="t in trucksWithROI" :key="t.id">
          <tr class="clickable-row" @click="toggleDetail(t.UnitNumber || t.unit_number)">
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
            <td class="mono">{{ t.loadCount || 0 }}</td>
            <td class="mono">{{ (t.totalMiles || 0).toLocaleString() }}</td>
            <td class="mono">{{ fmt(t.estRevenue) }}</td>
            <td>
              <span :class="['roi-badge', t.roi >= 0 ? 'positive' : 'negative']">
                {{ t.roi >= 0 ? '+' : '' }}{{ t.roi.toFixed(1) }}%
              </span>
            </td>
          </tr>
          <!-- Expandable P&L breakdown -->
          <tr v-if="expandedUnit === (t.UnitNumber || t.unit_number)" class="detail-row">
            <td colspan="9">
              <div class="truck-detail">
                <div class="detail-header">{{ t.UnitNumber }} &middot; {{ [t.Make, t.Model].filter(Boolean).join(' ') }} &middot; {{ t.AssignedDriver || 'Unassigned' }}</div>
                <div class="detail-sub">{{ t.loadCount || 0 }} completed load{{ t.loadCount !== 1 ? 's' : '' }} &middot; Monthly avg based on {{ truckMonths(t) }} month{{ truckMonths(t) !== 1 ? 's' : '' }}</div>
                <div class="detail-breakdown">
                  <div class="bd-row">
                    <span>Revenue ({{ t.loadCount || 0 }} load{{ t.loadCount !== 1 ? 's' : '' }})</span>
                    <span class="bd-val" style="color:var(--accent)">{{ fmt(perUnit(t)?.unitMonthlyGross) }}</span>
                  </div>
                  <div class="bd-row deduct">
                    <span>- Driver Pay</span>
                    <span class="bd-val">{{ fmt(-(driverPay(t))) }}<span class="bd-hint"> ({{ driverDays(t) }} days x ${{ driverRate(t) }})</span></span>
                  </div>
                  <div class="bd-row deduct">
                    <span>- Fixed Costs</span>
                    <span class="bd-val">{{ fmt(-(fixedCosts(t))) }}</span>
                  </div>
                  <div class="bd-row deduct">
                    <span>- Trip Expenses</span>
                    <span class="bd-val">{{ fmt(-(tripExp(t))) }}</span>
                  </div>
                  <div class="bd-divider"></div>
                  <div class="bd-row total">
                    <span>Monthly Net</span>
                    <span class="bd-val" :style="{color: monthlyNet(t) >= 0 ? 'var(--accent)' : 'var(--danger)'}">{{ fmt(monthlyNet(t)) }}</span>
                  </div>
                  <div class="bd-row">
                    <span>&times; 12 months</span>
                    <span class="bd-val"></span>
                  </div>
                  <div class="bd-row total">
                    <span>Est. Annual Revenue</span>
                    <span class="bd-val" style="color:var(--blue)">{{ fmt(t.estRevenue) }}</span>
                  </div>
                  <div class="bd-divider"></div>
                  <div class="bd-row">
                    <span>ROI ({{ fmt(t.estRevenue) }} / {{ fmt(truckPrice(t)) }})</span>
                    <span class="bd-val" :style="{color: t.roi >= 0 ? 'var(--accent)' : 'var(--danger)'}">{{ t.roi >= 0 ? '+' : '' }}{{ t.roi.toFixed(1) }}%</span>
                  </div>
                </div>
              </div>
            </td>
          </tr>
        </template>
      </tbody>
      <tfoot>
        <tr>
          <td colspan="5" class="total-label">Fleet Total</td>
          <td class="mono total-val">{{ totalLoads }}</td>
          <td></td>
          <td class="mono total-val">{{ fmt(totalEstRevenue) }}</td>
          <td>
            <span :class="['roi-badge', fleetROI >= 0 ? 'positive' : 'negative']">
              {{ fleetROI >= 0 ? '+' : '' }}{{ fleetROI.toFixed(1) }}%
            </span>
          </td>
        </tr>
      </tfoot>
    </table>
    <div class="fleet-note">
      Est. Revenue = (avg monthly gross - avg monthly expenses) x 12. ROI = Est. Revenue / Purchase Price x 100. Based on {{ monthsLabel }} of data — projections become more accurate over time.
    </div>
  </div>
</template>

<script setup>
import { ref, computed } from 'vue'
import { formatCurrency as fmt } from '../../utils/format'

const props = defineProps({
  trucks: { type: Array, default: () => [] },
  asset: { type: Object, default: () => ({}) },
  production: { type: Object, default: () => ({}) },
})

const expandedUnit = ref(null)
function toggleDetail(unit) { expandedUnit.value = expandedUnit.value === unit ? null : unit }

function perUnit(t) {
  const key = t.UnitNumber || t.unit_number || ''
  return (props.production?.perTruckData || {})[key] || {}
}
function truckPrice(t) { return t.PurchasePrice || t.purchase_price || props.asset?.purchasePrice || 0 }
function truckMonths(t) { return props.production?.monthsOfOperation || 1 }
function driverPay(t) {
  const driver = (t.AssignedDriver || t.assigned_driver || '').trim().toLowerCase()
  return (props.production?.driverPayDetails || {})[driver]?.totalPay || 0
}
function driverDays(t) {
  const driver = (t.AssignedDriver || t.assigned_driver || '').trim().toLowerCase()
  return (props.production?.driverPayDetails || {})[driver]?.activeDays || 0
}
function driverRate(t) {
  const driver = (t.AssignedDriver || t.assigned_driver || '').trim().toLowerCase()
  return (props.production?.driverPayDetails || {})[driver]?.dailyRate || 250
}
function fixedCosts(t) {
  const pu = perUnit(t)
  return (pu.unitMonthlyExpenses || 0) - (driverPay(t) / (truckMonths(t) || 1)) - tripExp(t)
}
function tripExp(t) {
  // tripExp = unitMonthlyExpenses - fixedCosts - driverPay/months
  // We don't have tripExp separately, so derive: total expenses - driverPay - (monthlyGross - monthlyNet - driverPay)
  // Simpler: just show unitMonthlyExpenses breakdown note
  return 0 // TODO: backend doesn't send per-truck trip expenses separately yet
}
function monthlyNet(t) {
  const pu = perUnit(t)
  return (pu.unitMonthlyGross || 0) - (pu.unitMonthlyExpenses || 0)
}

const trucksWithROI = computed(() => {
  const perTruckData = props.production?.perTruckData || {}
  const grossRevenue = props.production?.totalRevenue || 0
  const purchasePrice = props.asset?.purchasePrice || 0

  return props.trucks.map(t => {
    const unitKey = t.UnitNumber || t.unit_number || ''
    const perUnit = perTruckData[unitKey]
    const estRevenue = perUnit?.estAnnualRevenue ?? 0
    const truckPrice = t.PurchasePrice || t.purchase_price || purchasePrice
    // ROI = annual net profit / truck investment cost
    const roi = truckPrice > 0 ? (estRevenue / truckPrice) * 100 : 0
    const totalMiles = perUnit?.totalMiles ?? 0
    const loadCount = perUnit?.loadCount ?? 0
    return { ...t, estRevenue, roi, totalMiles, loadCount }
  })
})

const totalEstRevenue = computed(() => trucksWithROI.value.reduce((s, t) => s + t.estRevenue, 0))
const totalLoads = computed(() => trucksWithROI.value.reduce((s, t) => s + (t.loadCount || 0), 0))
// Fleet ROI = total est annual net / total fleet purchase price
const fleetROI = computed(() => {
  const totalPrice = props.production?.totalPurchasePrice || props.asset?.purchasePrice || 0
  if (totalPrice === 0) return 0
  return (totalEstRevenue.value / totalPrice) * 100
})

const monthsLabel = computed(() => {
  const m = props.production?.monthsOfOperation || 1
  return m + ' month' + (m !== 1 ? 's' : '')
})

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
.fleet-note {
  font-size: 0.68rem; color: var(--text-dim); font-style: italic;
  margin-top: 0.75rem; padding: 0.5rem 0; border-top: 1px solid var(--bg);
  line-height: 1.5;
}
</style>
