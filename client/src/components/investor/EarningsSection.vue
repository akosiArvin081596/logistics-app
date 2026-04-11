<template>
  <div class="section earnings-section">
    <div class="section-header">
      <div class="section-title">
        <div class="section-icon" style="background: var(--accent-dim); color: var(--accent);">&#128176;</div>
        Earnings Summary
      </div>
      <div class="month-nav">
        <button class="nav-btn" :disabled="selectedIdx <= 0" @click="selectedIdx--">&#9664;</button>
        <select v-model="selectedIdx" class="month-select">
          <option v-for="(m, i) in months" :key="m.month" :value="i">
            {{ monthLabel(m.month) }}{{ m.isCurrentMonth ? ' (current)' : '' }}
          </option>
        </select>
        <button class="nav-btn" :disabled="selectedIdx >= months.length - 1" @click="selectedIdx++">&#9654;</button>
      </div>
    </div>

    <template v-if="selected">
      <!-- Earnings Card — clickable -->
      <div class="earn-card clickable" :class="selected.investorEarnings >= 0 ? 'positive' : 'negative'" style="margin-bottom:1.25rem;" @click="openDetail('earnings')">
        <div class="earn-label">Your Earnings</div>
        <div class="earn-value">{{ fmt(selected.investorEarnings) }}</div>
        <div class="earn-sub">50% of net profit ({{ fmt(selected.netProfit) }})</div>
        <div class="earn-formula">= (revenue - driverPay - fixedCosts - tripExpenses) / 2</div>
        <div class="click-hint">Click to see full breakdown</div>
      </div>

      <!-- Breakdown Table -->
      <div class="breakdown">
        <div class="breakdown-row clickable" @click="openDetail('revenue')">
          <span class="breakdown-label">Revenue</span>
          <span class="breakdown-value" style="color: var(--accent)">{{ fmt(selected.revenue) }}</span>
          <span class="breakdown-formula">= SUM(Payment col, completed loads)</span>
        </div>
        <div class="breakdown-row deduct clickable" @click="openDetail('driverPay')">
          <span class="breakdown-label">- Driver Pay</span>
          <span class="breakdown-value">{{ fmt(-selected.driverPay) }}</span>
          <span class="breakdown-formula">= $250 x active days this month</span>
        </div>
        <div class="breakdown-row deduct clickable" @click="openDetail('fixedCosts')">
          <span class="breakdown-label">- Fixed Costs</span>
          <span class="breakdown-value">{{ fmt(-selected.fixedCosts) }}</span>
          <span class="breakdown-formula">= insurance + ELD + IRP/12 + HVUT/12 + maint fund</span>
        </div>
        <div class="breakdown-row deduct clickable" @click="openDetail('tripExpenses')">
          <span class="breakdown-label">- Trip Expenses</span>
          <span class="breakdown-value">{{ fmt(-selected.tripExpenses) }}</span>
          <span class="breakdown-formula">= fuel + tolls + repairs (from expenses table)</span>
        </div>
        <div class="breakdown-divider"></div>
        <div class="breakdown-row total clickable" @click="openDetail('netProfit')">
          <span class="breakdown-label">Net Profit</span>
          <span class="breakdown-value" :style="{ color: selected.netProfit >= 0 ? 'var(--accent)' : 'var(--danger)' }">{{ fmt(selected.netProfit) }}</span>
          <span class="breakdown-formula">= revenue - driverPay - fixedCosts - tripExpenses</span>
        </div>
        <div class="breakdown-row split">
          <span class="breakdown-label">&#247; 2 (50/50 split)</span>
          <span class="breakdown-value"></span>
          <span class="breakdown-formula"></span>
        </div>
        <div class="breakdown-row total clickable" @click="openDetail('earnings')">
          <span class="breakdown-label">Your Share</span>
          <span class="breakdown-value" :style="{ color: selected.investorEarnings >= 0 ? 'var(--accent)' : 'var(--danger)' }">{{ fmt(selected.investorEarnings) }}</span>
          <span class="breakdown-formula">= netProfit / 2</span>
        </div>
      </div>

      <div v-if="selected.isCurrentMonth" class="month-note">* {{ monthLabel(selected.month) }} &mdash; Month in progress</div>

      <!-- All-Time Summary -->
      <div class="alltime">
        <div class="alltime-title">All-Time Totals</div>
        <div class="alltime-grid">
          <div class="alltime-item clickable" @click="openDetail('allRevenue')">
            <span class="alltime-label">Revenue</span>
            <span class="alltime-value">{{ fmt(production.totalRevenue) }}</span>
            <span class="alltime-formula">= SUM(Payment, all completed loads)</span>
          </div>
          <div class="alltime-item clickable" @click="openDetail('allExpenses')">
            <span class="alltime-label">Expenses</span>
            <span class="alltime-value" style="color: var(--danger)">{{ fmt(production.totalExpenses) }}</span>
            <span class="alltime-formula">= driverPay + fixedCosts + tripExp</span>
          </div>
          <div class="alltime-item clickable" @click="openDetail('allNet')">
            <span class="alltime-label">Net</span>
            <span class="alltime-value" :style="{ color: production.netRevenueToDate >= 0 ? 'var(--accent)' : 'var(--danger)' }">{{ fmt(production.netRevenueToDate) }}</span>
            <span class="alltime-formula">= revenue - expenses</span>
          </div>
          <div class="alltime-item clickable" @click="openDetail('allEarnings')">
            <span class="alltime-label">Your Earnings</span>
            <span class="alltime-value" :style="{ color: production.investorEarnings >= 0 ? 'var(--accent)' : 'var(--danger)' }">{{ fmt(production.investorEarnings) }}</span>
            <span class="alltime-formula">= net / 2 (50/50 split)</span>
          </div>
        </div>
      </div>
    </template>
    <div v-else class="empty">No earnings data yet.</div>

    <!-- Computation Detail Modal -->
    <Dialog :open="!!detailType" @update:open="v => { if (!v) detailType = '' }">
      <DialogContent class="detail-modal">
        <DialogHeader>
          <DialogTitle>{{ modalTitle }}</DialogTitle>
          <DialogDescription>{{ modalSubtitle }}</DialogDescription>
        </DialogHeader>

        <!-- MONTHLY: Full P&L Breakdown -->
        <template v-if="detailType === 'earnings' && selected">
          <div class="modal-breakdown">
            <div class="modal-row highlight">
              <span>Revenue</span>
              <span class="val accent">{{ fmt(selected.revenue) }}</span>
            </div>
            <div class="modal-formula">SUM of Payment column from all completed loads this month</div>
            <div class="modal-row deduct">
              <span>- Driver Pay</span>
              <span class="val danger">{{ fmt(-selected.driverPay) }}</span>
            </div>
            <div class="modal-formula">$250/day x active driving days (pickup-to-dropoff, deduplicated)</div>
            <div class="modal-row deduct">
              <span>- Fixed Costs</span>
              <span class="val danger">{{ fmt(-selected.fixedCosts) }}</span>
            </div>
            <div class="modal-formula">Insurance + ELD + IRP/12 + HVUT/12 + Maintenance Reserve</div>
            <div class="modal-row deduct">
              <span>- Trip Expenses</span>
              <span class="val danger">{{ fmt(-selected.tripExpenses) }}</span>
            </div>
            <div class="modal-formula">Fuel + tolls + repairs from expenses table</div>
            <div class="modal-divider"></div>
            <div class="modal-row bold">
              <span>Net Profit</span>
              <span class="val" :class="selected.netProfit >= 0 ? 'accent' : 'danger'">{{ fmt(selected.netProfit) }}</span>
            </div>
            <div class="modal-formula">{{ fmt(selected.revenue) }} - {{ fmt(selected.driverPay) }} - {{ fmt(selected.fixedCosts) }} - {{ fmt(selected.tripExpenses) }} = {{ fmt(selected.netProfit) }}</div>
            <div class="modal-row split-row">
              <span>&#247; 2 (50/50 split)</span>
              <span></span>
            </div>
            <div class="modal-row bold result">
              <span>Your Earnings</span>
              <span class="val" :class="selected.investorEarnings >= 0 ? 'accent' : 'danger'">{{ fmt(selected.investorEarnings) }}</span>
            </div>
            <div class="modal-formula">{{ fmt(selected.netProfit) }} / 2 = {{ fmt(selected.investorEarnings) }}</div>
          </div>
        </template>

        <!-- MONTHLY: Revenue detail -->
        <template v-if="detailType === 'revenue' && selected">
          <div class="modal-breakdown">
            <div class="modal-explain">Total payment received from all completed loads in {{ monthLabel(selected.month) }}.</div>
            <div class="modal-row bold result">
              <span>Revenue</span>
              <span class="val accent">{{ fmt(selected.revenue) }}</span>
            </div>
            <div class="modal-formula">= SUM(Payment column, completed loads for {{ monthLabel(selected.month) }})</div>
          </div>
        </template>

        <!-- MONTHLY: Driver Pay detail -->
        <template v-if="detailType === 'driverPay' && selected">
          <div class="modal-breakdown">
            <div class="modal-explain">Each driver is paid $250 per active day. Active days are calendar days between pickup and dropoff dates, deduplicated across overlapping loads.</div>
            <template v-if="Object.keys(driverDetails).length">
              <div class="modal-row" v-for="(d, name) in driverDetails" :key="name">
                <span>{{ name }}</span>
                <span class="val danger">{{ fmt(d.totalPay) }}</span>
              </div>
              <div class="modal-formula" v-for="(d, name) in driverDetails" :key="name + '-f'" style="padding-bottom:0.35rem;">
                {{ name }}: {{ d.activeDays }} days x ${{ d.dailyRate || 250 }}/day
              </div>
            </template>
            <div class="modal-divider"></div>
            <div class="modal-row bold result">
              <span>Total Driver Pay</span>
              <span class="val danger">{{ fmt(selected.driverPay) }}</span>
            </div>
            <div class="modal-formula">= $250 x active days in {{ monthLabel(selected.month) }}</div>
          </div>
        </template>

        <!-- MONTHLY: Fixed Costs detail -->
        <template v-if="detailType === 'fixedCosts' && selected">
          <div class="modal-breakdown">
            <div class="modal-explain">Monthly fixed costs across {{ fcb.truckCount || 1 }} truck{{ (fcb.truckCount || 1) > 1 ? 's' : '' }}, prorated from annual fees where applicable.</div>
            <div class="modal-row">
              <span>Insurance (monthly)</span>
              <span class="val danger">{{ fmt(fcb.insurance) }}</span>
            </div>
            <div class="modal-row">
              <span>ELD (monthly)</span>
              <span class="val danger">{{ fmt(fcb.eld) }}</span>
            </div>
            <div class="modal-row">
              <span>IRP (annual / 12)</span>
              <span class="val danger">{{ fmt(fcb.irp) }}</span>
            </div>
            <div class="modal-row">
              <span>HVUT (annual / 12)</span>
              <span class="val danger">{{ fmt(fcb.hvut) }}</span>
            </div>
            <div class="modal-row">
              <span>Maintenance Reserve</span>
              <span class="val danger">{{ fmt(fcb.maintReserve) }}</span>
            </div>
            <div class="modal-divider"></div>
            <div class="modal-row bold result">
              <span>Total Fixed Costs</span>
              <span class="val danger">{{ fmt(selected.fixedCosts) }}</span>
            </div>
            <div class="modal-formula">{{ fmt(fcb.insurance) }} + {{ fmt(fcb.eld) }} + {{ fmt(fcb.irp) }} + {{ fmt(fcb.hvut) }} + {{ fmt(fcb.maintReserve) }} = {{ fmt(selected.fixedCosts) }}/mo</div>
          </div>
        </template>

        <!-- MONTHLY: Trip Expenses detail -->
        <template v-if="detailType === 'tripExpenses' && selected">
          <div class="modal-breakdown">
            <div class="modal-explain">Variable expenses logged against loads this month, sourced from the expenses table.</div>
            <div class="modal-row"><span>Fuel</span><span class="val">from expenses</span></div>
            <div class="modal-row"><span>Tolls</span><span class="val">from expenses</span></div>
            <div class="modal-row"><span>Repairs</span><span class="val">from expenses</span></div>
            <div class="modal-row"><span>Other</span><span class="val">from expenses</span></div>
            <div class="modal-divider"></div>
            <div class="modal-row bold result">
              <span>Total Trip Expenses</span>
              <span class="val danger">{{ fmt(selected.tripExpenses) }}</span>
            </div>
            <div class="modal-formula">= SUM of all expenses for {{ monthLabel(selected.month) }}</div>
          </div>
        </template>

        <!-- MONTHLY: Net Profit detail -->
        <template v-if="detailType === 'netProfit' && selected">
          <div class="modal-breakdown">
            <div class="modal-row highlight">
              <span>Revenue</span>
              <span class="val accent">{{ fmt(selected.revenue) }}</span>
            </div>
            <div class="modal-row deduct">
              <span>- Driver Pay</span>
              <span class="val danger">{{ fmt(-selected.driverPay) }}</span>
            </div>
            <div class="modal-row deduct">
              <span>- Fixed Costs</span>
              <span class="val danger">{{ fmt(-selected.fixedCosts) }}</span>
            </div>
            <div class="modal-row deduct">
              <span>- Trip Expenses</span>
              <span class="val danger">{{ fmt(-selected.tripExpenses) }}</span>
            </div>
            <div class="modal-divider"></div>
            <div class="modal-row bold result">
              <span>Net Profit</span>
              <span class="val" :class="selected.netProfit >= 0 ? 'accent' : 'danger'">{{ fmt(selected.netProfit) }}</span>
            </div>
            <div class="modal-formula">{{ fmt(selected.revenue) }} - {{ fmt(selected.driverPay) }} - {{ fmt(selected.fixedCosts) }} - {{ fmt(selected.tripExpenses) }} = {{ fmt(selected.netProfit) }}</div>
          </div>
        </template>

        <!-- ALL-TIME: Revenue -->
        <template v-if="detailType === 'allRevenue'">
          <div class="modal-breakdown">
            <div class="modal-explain">Total payment from all completed loads across all months.</div>
            <div class="modal-monthly-list" v-if="months.length">
              <div class="modal-row" v-for="m in months" :key="m.month">
                <span>{{ monthLabel(m.month) }}{{ m.isCurrentMonth ? ' *' : '' }}</span>
                <span class="val accent">{{ fmt(m.revenue) }}</span>
              </div>
            </div>
            <div class="modal-divider"></div>
            <div class="modal-row bold result">
              <span>All-Time Revenue</span>
              <span class="val accent">{{ fmt(production.totalRevenue) }}</span>
            </div>
          </div>
        </template>

        <!-- ALL-TIME: Expenses -->
        <template v-if="detailType === 'allExpenses'">
          <div class="modal-breakdown">
            <div class="modal-explain">Total of all cost categories across all months.</div>
            <div class="modal-row">
              <span>Driver Pay</span>
              <span class="val danger">{{ fmt(allTimeDriverPay) }}</span>
            </div>
            <div class="modal-formula">$250/day x all active driving days</div>
            <div class="modal-row">
              <span>Fixed Costs</span>
              <span class="val danger">{{ fmt(allTimeFixedCosts) }}</span>
            </div>
            <div class="modal-formula">Insurance + ELD + IRP/12 + HVUT/12 + Maint Reserve (monthly per truck)</div>
            <div class="modal-row">
              <span>Trip Expenses</span>
              <span class="val danger">{{ fmt(allTimeTripExpenses) }}</span>
            </div>
            <div class="modal-formula">Fuel + tolls + repairs from expenses table</div>
            <div class="modal-divider"></div>
            <div class="modal-row bold result">
              <span>Total Expenses</span>
              <span class="val danger">{{ fmt(allTimeDriverPay + allTimeFixedCosts + allTimeTripExpenses) }}</span>
            </div>
            <div class="modal-formula">{{ fmt(allTimeDriverPay) }} + {{ fmt(allTimeFixedCosts) }} + {{ fmt(allTimeTripExpenses) }} = {{ fmt(allTimeDriverPay + allTimeFixedCosts + allTimeTripExpenses) }}</div>
          </div>
        </template>

        <!-- ALL-TIME: Net -->
        <template v-if="detailType === 'allNet'">
          <div class="modal-breakdown">
            <div class="modal-row highlight">
              <span>Revenue</span>
              <span class="val accent">{{ fmt(production.totalRevenue) }}</span>
            </div>
            <div class="modal-row deduct">
              <span>- Total Expenses</span>
              <span class="val danger">{{ fmt(-production.totalExpenses) }}</span>
            </div>
            <div class="modal-divider"></div>
            <div class="modal-row bold result">
              <span>Net Profit</span>
              <span class="val" :class="production.netRevenueToDate >= 0 ? 'accent' : 'danger'">{{ fmt(production.netRevenueToDate) }}</span>
            </div>
            <div class="modal-formula">{{ fmt(production.totalRevenue) }} - {{ fmt(production.totalExpenses) }} = {{ fmt(production.netRevenueToDate) }}</div>
          </div>
        </template>

        <!-- ALL-TIME: Your Earnings -->
        <template v-if="detailType === 'allEarnings'">
          <div class="modal-breakdown">
            <div class="modal-row highlight">
              <span>Net Profit</span>
              <span class="val" :class="production.netRevenueToDate >= 0 ? 'accent' : 'danger'">{{ fmt(production.netRevenueToDate) }}</span>
            </div>
            <div class="modal-row split-row">
              <span>&#247; 2 (50/50 split)</span>
              <span></span>
            </div>
            <div class="modal-divider"></div>
            <div class="modal-row bold result">
              <span>Your Earnings</span>
              <span class="val" :class="production.investorEarnings >= 0 ? 'accent' : 'danger'">{{ fmt(production.investorEarnings) }}</span>
            </div>
            <div class="modal-formula">{{ fmt(production.netRevenueToDate) }} / 2 = {{ fmt(production.investorEarnings) }}</div>
            <div class="modal-monthly-list" v-if="months.length" style="margin-top:0.75rem;">
              <div class="modal-explain">Monthly breakdown:</div>
              <div class="modal-row" v-for="m in months" :key="m.month">
                <span>{{ monthLabel(m.month) }}{{ m.isCurrentMonth ? ' *' : '' }}</span>
                <span class="val" :class="m.investorEarnings >= 0 ? 'accent' : 'danger'">{{ fmt(m.investorEarnings) }}</span>
              </div>
            </div>
          </div>
        </template>

      </DialogContent>
    </Dialog>
  </div>
</template>

<script setup>
import { ref, computed, watch } from 'vue'
import { formatCurrency as fmt } from '../../utils/format'
import { Dialog, DialogContent, DialogHeader, DialogTitle, DialogDescription } from '../ui/dialog'

const props = defineProps({
  production: { type: Object, default: () => ({}) },
})

const months = computed(() => props.production?.monthlyEarnings || [])
const selectedIdx = ref(0)

// Default to current month (last item) when data loads; clamp if months shrinks
watch(months, (v) => {
  if (v.length) selectedIdx.value = Math.min(selectedIdx.value, v.length - 1) || v.length - 1
  else selectedIdx.value = 0
}, { immediate: true })

const selected = computed(() => months.value[selectedIdx.value] || null)

const MONTH_NAMES = ['January', 'February', 'March', 'April', 'May', 'June', 'July', 'August', 'September', 'October', 'November', 'December']
function monthLabel(mk) {
  if (!mk) return ''
  const [y, m] = mk.split('-')
  return `${MONTH_NAMES[parseInt(m) - 1] || m} ${y}`
}

// --- Detail modal ---
const detailType = ref('')
const fcb = computed(() => props.production?.fixedCostBreakdown || { insurance: 0, eld: 0, irp: 0, hvut: 0, maintReserve: 0, truckCount: 1 })
const driverDetails = computed(() => props.production?.driverPayDetails || {})

function openDetail(type) {
  detailType.value = type
}

// All-time expense sub-totals derived from monthly data
const allTimeDriverPay = computed(() => months.value.reduce((s, m) => s + (m.driverPay || 0), 0))
const allTimeFixedCosts = computed(() => months.value.reduce((s, m) => s + (m.fixedCosts || 0), 0))
const allTimeTripExpenses = computed(() => months.value.reduce((s, m) => s + (m.tripExpenses || 0), 0))

const MODAL_CONFIG = {
  earnings:     { title: 'Monthly Earnings Breakdown', subtitle: 'How your earnings are calculated for this month' },
  revenue:      { title: 'Revenue', subtitle: 'Total payment from completed loads' },
  driverPay:    { title: 'Driver Pay', subtitle: 'Cost of driver compensation' },
  fixedCosts:   { title: 'Fixed Costs', subtitle: 'Monthly truck operating costs' },
  tripExpenses: { title: 'Trip Expenses', subtitle: 'Variable per-trip costs' },
  netProfit:    { title: 'Net Profit', subtitle: 'Revenue minus all costs' },
  allRevenue:   { title: 'All-Time Revenue', subtitle: 'Revenue across all months' },
  allExpenses:  { title: 'All-Time Expenses', subtitle: 'Expense breakdown across all months' },
  allNet:       { title: 'All-Time Net Profit', subtitle: 'Total revenue minus total expenses' },
  allEarnings:  { title: 'All-Time Your Earnings', subtitle: 'Your 50% share of net profit' },
}

const modalTitle = computed(() => {
  const cfg = MODAL_CONFIG[detailType.value]
  if (!cfg) return ''
  const isMonthly = !detailType.value.startsWith('all') && selected.value
  return isMonthly ? `${cfg.title} — ${monthLabel(selected.value.month)}` : cfg.title
})
const modalSubtitle = computed(() => MODAL_CONFIG[detailType.value]?.subtitle || '')
</script>

<style scoped>
.earnings-section {
  background: var(--surface);
  border: 2px solid var(--accent);
  border-radius: var(--radius);
  padding: 1.25rem;
  margin-bottom: 1.25rem;
}
.section-header {
  display: flex; justify-content: space-between; align-items: center;
  margin-bottom: 1rem; flex-wrap: wrap; gap: 0.75rem;
}
.section-title {
  font-size: 0.95rem; font-weight: 700;
  display: flex; align-items: center; gap: 0.5rem;
}
.section-icon {
  width: 28px; height: 28px; border-radius: 8px;
  display: flex; align-items: center; justify-content: center; font-size: 0.9rem;
}
.month-nav {
  display: flex; align-items: center; gap: 0.4rem;
}
.nav-btn {
  width: 28px; height: 28px; border-radius: 6px;
  border: 1px solid var(--border); background: var(--bg);
  cursor: pointer; font-size: 0.7rem; color: var(--text);
  display: flex; align-items: center; justify-content: center;
}
.nav-btn:disabled { opacity: 0.3; cursor: default; }
.nav-btn:hover:not(:disabled) { background: var(--accent-dim); border-color: var(--accent); }
.month-select {
  padding: 0.35rem 0.6rem; border-radius: 6px;
  border: 1px solid var(--border); background: var(--bg);
  font-family: inherit; font-size: 0.78rem; font-weight: 600;
  color: var(--text); cursor: pointer;
}
.month-select:focus { outline: none; border-color: var(--accent); }

/* Earnings Card */
.earn-card {
  padding: 1.25rem; border-radius: var(--radius); text-align: center;
  border: 1px solid var(--border);
}
.earn-card.positive { border-color: var(--accent); background: rgba(16, 185, 129, 0.04); }
.earn-card.negative { border-color: var(--danger); background: rgba(239, 68, 68, 0.04); }
.earn-card.company { border-color: var(--blue); background: rgba(59, 130, 246, 0.04); }
.earn-label {
  font-size: 0.72rem; font-weight: 600; color: var(--text-dim);
  text-transform: uppercase; letter-spacing: 0.04em; margin-bottom: 0.4rem;
}
.earn-value {
  font-family: 'JetBrains Mono', monospace; font-size: 1.8rem; font-weight: 700;
}
.earn-card.positive .earn-value { color: var(--accent); }
.earn-card.negative .earn-value { color: var(--danger); }
.earn-sub { font-size: 0.72rem; color: var(--text-dim); margin-top: 0.2rem; }
.earn-formula {
  font-size: 0.58rem; font-family: 'JetBrains Mono', monospace;
  color: var(--text-dim); opacity: 0.5; font-style: italic; margin-top: 0.15rem;
}

/* Breakdown Table */
.breakdown {
  background: var(--bg); border-radius: 8px; padding: 0.75rem 1rem; margin-bottom: 1rem;
}
.breakdown-row {
  display: grid; grid-template-columns: 1fr auto 1fr; gap: 0.5rem;
  padding: 0.4rem 0; align-items: center;
}
.breakdown-label { font-size: 0.82rem; font-weight: 500; }
.breakdown-value {
  font-family: 'JetBrains Mono', monospace; font-size: 0.85rem; font-weight: 600;
  text-align: right;
}
.breakdown-formula {
  font-size: 0.55rem; font-family: 'JetBrains Mono', monospace;
  color: var(--text-dim); opacity: 0.5; font-style: italic; text-align: right;
}
.breakdown-row.deduct .breakdown-label { color: var(--text-dim); }
.breakdown-row.deduct .breakdown-value { color: var(--danger); }
.breakdown-row.total { font-weight: 700; }
.breakdown-row.total .breakdown-label { font-weight: 700; }
.breakdown-row.split .breakdown-label { color: var(--text-dim); font-size: 0.75rem; }
.breakdown-divider {
  border-top: 1px dashed var(--border); margin: 0.3rem 0;
}

.month-note {
  font-size: 0.72rem; color: var(--text-dim); font-style: italic; margin-bottom: 1rem;
}

/* All-Time Summary */
.alltime {
  background: var(--bg); border-radius: 8px; padding: 0.75rem 1rem;
}
.alltime-title {
  font-size: 0.68rem; font-weight: 600; color: var(--text-dim);
  text-transform: uppercase; letter-spacing: 0.04em; margin-bottom: 0.5rem;
}
.alltime-grid { display: grid; grid-template-columns: repeat(4, 1fr); gap: 0.75rem; }
.alltime-item { text-align: center; }
.alltime-label { font-size: 0.65rem; color: var(--text-dim); display: block; }
.alltime-value {
  font-family: 'JetBrains Mono', monospace; font-size: 0.95rem; font-weight: 700;
  display: block; margin-top: 0.15rem;
}
.alltime-formula {
  font-size: 0.55rem; font-family: 'JetBrains Mono', monospace;
  color: var(--text-dim); opacity: 0.5; font-style: italic;
  display: block; margin-top: 0.1rem;
}

.empty { text-align: center; color: var(--text-dim); padding: 2rem; font-size: 0.85rem; }

/* Clickable elements */
.clickable { cursor: pointer; transition: all 0.15s ease; position: relative; }
.earn-card.clickable:hover { box-shadow: 0 2px 12px rgba(0,0,0,0.08); transform: translateY(-1px); }
.breakdown-row.clickable { border-radius: 6px; padding-left: 0.5rem; padding-right: 0.5rem; margin: 0 -0.5rem; }
.breakdown-row.clickable:hover { background: var(--accent-dim); }
.alltime-item.clickable { border-radius: 8px; padding: 0.5rem; margin: -0.5rem; }
.alltime-item.clickable:hover { background: var(--accent-dim); }
.click-hint {
  font-size: 0.58rem; color: var(--text-dim); opacity: 0; margin-top: 0.3rem;
  transition: opacity 0.15s ease;
}
.earn-card.clickable:hover .click-hint { opacity: 0.6; }

/* Detail Modal */
.detail-modal { max-width: 520px; }
.modal-breakdown { padding: 0.25rem 0; }
.modal-row {
  display: flex; justify-content: space-between; align-items: center;
  padding: 0.5rem 0.75rem; font-size: 0.85rem;
}
.modal-row .val {
  font-family: 'JetBrains Mono', monospace; font-weight: 600; font-size: 0.88rem;
}
.modal-row .val.accent { color: var(--accent); }
.modal-row .val.danger { color: var(--danger); }
.modal-row.highlight { background: rgba(16, 185, 129, 0.06); border-radius: 6px; }
.modal-row.deduct { color: var(--text-dim); }
.modal-row.bold { font-weight: 700; }
.modal-row.result { background: var(--bg); border-radius: 6px; font-size: 0.92rem; }
.modal-row.split-row { color: var(--text-dim); font-size: 0.78rem; }
.modal-divider { border-top: 1px dashed var(--border); margin: 0.4rem 0.75rem; }
.modal-formula {
  font-size: 0.62rem; font-family: 'JetBrains Mono', monospace;
  color: var(--text-dim); opacity: 0.6; font-style: italic;
  padding: 0 0.75rem 0.25rem;
}
.modal-explain {
  font-size: 0.78rem; color: var(--text-dim); padding: 0.25rem 0.75rem 0.5rem;
  line-height: 1.4;
}
.modal-monthly-list { max-height: 300px; overflow-y: auto; }
.modal-monthly-list .modal-row { font-size: 0.8rem; padding: 0.35rem 0.75rem; }
.modal-monthly-list .modal-row:nth-child(even) { background: var(--bg); border-radius: 4px; }

@media (max-width: 600px) {
  .alltime-grid { grid-template-columns: repeat(2, 1fr); }
  .breakdown-row { grid-template-columns: 1fr auto; }
  .breakdown-formula { display: none; }
  .detail-modal { max-width: 95vw; }
}
</style>
