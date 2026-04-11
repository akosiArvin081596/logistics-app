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
      <!-- Earnings Cards -->
      <div class="earnings-cards">
        <div class="earn-card" :class="selected.investorEarnings >= 0 ? 'positive' : 'negative'">
          <div class="earn-label">Your Earnings</div>
          <div class="earn-value">{{ fmt(selected.investorEarnings) }}</div>
          <div class="earn-sub">50% of net profit</div>
          <div class="earn-formula">= netProfit / 2</div>
        </div>
        <div class="earn-card company">
          <div class="earn-label">Company Earnings</div>
          <div class="earn-value">{{ fmt(selected.companyEarnings) }}</div>
          <div class="earn-sub">50% of net profit</div>
          <div class="earn-formula">= netProfit / 2</div>
        </div>
      </div>

      <!-- Breakdown Table -->
      <div class="breakdown">
        <div class="breakdown-row">
          <span class="breakdown-label">Revenue</span>
          <span class="breakdown-value" style="color: var(--accent)">{{ fmt(selected.revenue) }}</span>
          <span class="breakdown-formula">= SUM(Payment col, completed loads)</span>
        </div>
        <div class="breakdown-row deduct">
          <span class="breakdown-label">- Driver Pay</span>
          <span class="breakdown-value">{{ fmt(-selected.driverPay) }}</span>
          <span class="breakdown-formula">= $250 x active days this month</span>
        </div>
        <div class="breakdown-row deduct">
          <span class="breakdown-label">- Fixed Costs</span>
          <span class="breakdown-value">{{ fmt(-selected.fixedCosts) }}</span>
          <span class="breakdown-formula">= insurance + ELD + IRP/12 + HVUT/12 + maint fund</span>
        </div>
        <div class="breakdown-row deduct">
          <span class="breakdown-label">- Trip Expenses</span>
          <span class="breakdown-value">{{ fmt(-selected.tripExpenses) }}</span>
          <span class="breakdown-formula">= fuel + tolls + repairs (from expenses table)</span>
        </div>
        <div class="breakdown-divider"></div>
        <div class="breakdown-row total">
          <span class="breakdown-label">Net Profit</span>
          <span class="breakdown-value" :style="{ color: selected.netProfit >= 0 ? 'var(--accent)' : 'var(--danger)' }">{{ fmt(selected.netProfit) }}</span>
          <span class="breakdown-formula">= revenue - driverPay - fixedCosts - tripExpenses</span>
        </div>
        <div class="breakdown-row split">
          <span class="breakdown-label">&#247; 2 (50/50 split)</span>
          <span class="breakdown-value"></span>
          <span class="breakdown-formula"></span>
        </div>
        <div class="breakdown-row total">
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
          <div class="alltime-item">
            <span class="alltime-label">Revenue</span>
            <span class="alltime-value">{{ fmt(production.totalRevenue) }}</span>
          </div>
          <div class="alltime-item">
            <span class="alltime-label">Expenses</span>
            <span class="alltime-value" style="color: var(--danger)">{{ fmt(production.totalExpenses) }}</span>
          </div>
          <div class="alltime-item">
            <span class="alltime-label">Net</span>
            <span class="alltime-value" :style="{ color: production.netRevenueToDate >= 0 ? 'var(--accent)' : 'var(--danger)' }">{{ fmt(production.netRevenueToDate) }}</span>
          </div>
          <div class="alltime-item">
            <span class="alltime-label">Your Earnings</span>
            <span class="alltime-value" :style="{ color: production.investorEarnings >= 0 ? 'var(--accent)' : 'var(--danger)' }">{{ fmt(production.investorEarnings) }}</span>
          </div>
        </div>
      </div>
    </template>
    <div v-else class="empty">No earnings data yet.</div>
  </div>
</template>

<script setup>
import { ref, computed, watch } from 'vue'

const props = defineProps({
  production: { type: Object, default: () => ({}) },
})

const months = computed(() => props.production?.monthlyEarnings || [])
const selectedIdx = ref(0)

// Default to current month (last item) when data loads
watch(months, (v) => {
  if (v.length) selectedIdx.value = v.length - 1
}, { immediate: true })

const selected = computed(() => months.value[selectedIdx.value] || null)

const MONTH_NAMES = ['', 'January', 'February', 'March', 'April', 'May', 'June', 'July', 'August', 'September', 'October', 'November', 'December']
function monthLabel(mk) {
  if (!mk) return ''
  const [y, m] = mk.split('-')
  return `${MONTH_NAMES[parseInt(m)]} ${y}`
}

function fmt(n) {
  const v = Number(n || 0)
  const prefix = v < 0 ? '-$' : '$'
  return prefix + Math.abs(v).toLocaleString('en-US', { maximumFractionDigits: 0 })
}
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

/* Earnings Cards */
.earnings-cards {
  display: grid; grid-template-columns: 1fr 1fr; gap: 1rem; margin-bottom: 1.25rem;
}
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
.earn-card.company .earn-value { color: var(--blue); }
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

.empty { text-align: center; color: var(--text-dim); padding: 2rem; font-size: 0.85rem; }

@media (max-width: 600px) {
  .earnings-cards { grid-template-columns: 1fr; }
  .alltime-grid { grid-template-columns: repeat(2, 1fr); }
  .breakdown-row { grid-template-columns: 1fr auto; }
  .breakdown-formula { display: none; }
}
</style>
