<template>
  <div>
    <div class="table-scroll" role="region" aria-label="Fleet P&amp;L by period" tabindex="0">
      <table class="data-table pnl-table">
        <thead>
          <tr>
            <th scope="col" class="sticky-col line-col">Line</th>
            <th v-for="p in periods" :key="p.key" scope="col" class="num period-col">
              <button
                v-if="monthClickable"
                type="button"
                class="period-btn"
                :title="`Open the ${p.label} breakdown`"
                @click="emit('open-month', p.key)"
              >{{ p.label }}</button>
              <span v-else class="period-label">{{ p.label }}</span>
              <BasisBadge :basis="p.basis" show-none class="period-badge" />
            </th>
            <th scope="col" class="num period-col total-col">
              <span class="period-label">Total</span>
              <BasisBadge :basis="total.basis" class="period-badge" />
            </th>
          </tr>
        </thead>
        <tbody>
          <tr class="row-strong">
            <th scope="row" class="sticky-col">Revenue</th>
            <td v-for="p in periods" :key="p.key" class="num">{{ money(p.key, (f) => f.revenue) }}</td>
            <td class="num total-col">{{ formatMoney(total.revenue) }}</td>
          </tr>
          <tr class="section-row">
            <th scope="rowgroup" class="sticky-col">Costs</th>
            <td :colspan="periods.length + 1"></td>
          </tr>
          <tr v-for="line in lines" :key="line.key" :class="{ 'line-off': !isOn(line.key) }">
            <th scope="row" class="sticky-col line-name">
              {{ line.label }}
              <span v-if="!isOn(line.key)" class="off-chip" title="Switched off in Cost settings: shown, not counted in total costs or margin">not counted</span>
            </th>
            <td v-for="p in periods" :key="p.key" class="num">{{ money(p.key, (f) => f.costs?.[line.key]) }}</td>
            <td class="num total-col">{{ formatMoney(total.costs?.[line.key]) }}</td>
          </tr>
          <tr class="row-strong row-rule">
            <th scope="row" class="sticky-col">Total costs</th>
            <td v-for="p in periods" :key="p.key" class="num">{{ money(p.key, (f) => f.totalCosts) }}</td>
            <td class="num total-col">{{ formatMoney(total.totalCosts) }}</td>
          </tr>
          <tr class="row-strong">
            <th scope="row" class="sticky-col">Margin</th>
            <td v-for="p in periods" :key="p.key" class="num" :class="sign(p.key, 'margin')">{{ money(p.key, (f) => f.margin) }}</td>
            <td class="num total-col" :class="signClass(total.margin)">{{ formatMoney(total.margin) }}</td>
          </tr>
          <tr>
            <th scope="row" class="sticky-col">Margin %</th>
            <td v-for="p in periods" :key="p.key" class="num" :class="sign(p.key, 'marginPct')">{{ pct(p.key) }}</td>
            <td class="num total-col" :class="signClass(total.marginPct)">{{ formatPct(total.marginPct) }}</td>
          </tr>
          <tr v-if="hasSettlement" class="row-note">
            <th scope="row" class="sticky-col" title="Closed months brought to the figures they settled at; already included in the lines above">
              Settlement adjustment <span class="dim-text">(included)</span>
            </th>
            <td v-for="p in periods" :key="p.key" class="num">{{ money(p.key, (f) => f.settlementAdjustment) }}</td>
            <td class="num total-col">{{ formatMoney(total.settlementAdjustment) }}</td>
          </tr>
          <tr class="section-row">
            <th scope="rowgroup" class="sticky-col">Operations</th>
            <td :colspan="periods.length + 1"></td>
          </tr>
          <tr>
            <th scope="row" class="sticky-col">Loads</th>
            <td v-for="p in periods" :key="p.key" class="num">{{ count(p.key, 'loads') }}</td>
            <td class="num total-col">{{ formatCount(total.loads) }}</td>
          </tr>
          <tr>
            <th scope="row" class="sticky-col">Miles</th>
            <td v-for="p in periods" :key="p.key" class="num">{{ count(p.key, 'miles') }}</td>
            <td class="num total-col">{{ formatCount(total.miles) }}</td>
          </tr>
          <tr>
            <th scope="row" class="sticky-col">Revenue / mile</th>
            <td v-for="p in periods" :key="p.key" class="num">{{ money(p.key, (f) => f.revenuePerMile) }}</td>
            <td class="num total-col">{{ formatPerMile(total.revenuePerMile) }}</td>
          </tr>
          <tr>
            <th scope="row" class="sticky-col">Cost / mile</th>
            <td v-for="p in periods" :key="p.key" class="num">{{ money(p.key, (f) => f.costPerMile) }}</td>
            <td class="num total-col">{{ formatPerMile(total.costPerMile) }}</td>
          </tr>
        </tbody>
      </table>
    </div>
    <p class="table-foot">
      Lines marked "not counted" are switched off in Cost settings; their values are shown but left out of total costs
      and margin. Closed months keep the settings they closed with.
      <template v-if="monthClickable"> Select a month's heading for its full breakdown.</template>
    </p>
  </div>
</template>

<script setup>
import { computed } from 'vue'
import BasisBadge from './BasisBadge.vue'
import { formatCount, formatMoney, formatPct, formatPerMile, signClass } from '../../lib/financialsView'

// Fleet P&L: lines down, periods across, every cell a server figure
// (report.totalByPeriod[period], report.total). A period with nothing recorded
// has no figures object and shows "—".
const props = defineProps({
  report: { type: Object, required: true },
})
const emit = defineEmits(['open-month'])

const periods = computed(() => props.report.periods || [])
const lines = computed(() => props.report.lines || [])
const total = computed(() => props.report.total || {})
const byPeriod = computed(() => props.report.totalByPeriod || {})
const monthClickable = computed(() => props.report.granularity === 'month')

// The CURRENT settings; a closed month may have closed with others.
const isOn = (key) => props.report.settings?.costs?.[key] !== false

const hasSettlement = computed(() => {
  if (Number(total.value.settlementAdjustment)) return true
  return Object.values(byPeriod.value).some((f) => Number(f?.settlementAdjustment))
})

const fig = (key) => byPeriod.value[key] || null
function money(key, pick) {
  const f = fig(key)
  return f ? formatMoney(pick(f)) : '—'
}
function count(key, field) {
  const f = fig(key)
  return f ? formatCount(f[field]) : '—'
}
function pct(key) {
  const f = fig(key)
  return f ? formatPct(f.marginPct) : '—'
}
function sign(key, field) {
  const f = fig(key)
  return f ? signClass(f[field]) : ''
}
</script>

<style scoped>
.table-scroll {
  overflow-x: auto;
  max-width: 100%;
  border: 1px solid var(--border);
  border-radius: 10px;
}
.table-scroll:focus-visible { outline: 2px solid var(--accent); outline-offset: 2px; }
.data-table {
  width: 100%;
  border-collapse: separate;
  border-spacing: 0;
  font-size: 0.8rem;
}
.data-table th,
.data-table td {
  padding: 0.5rem 0.65rem;
  border-bottom: 1px solid var(--bg);
  white-space: nowrap;
}
.data-table thead th {
  text-align: left;
  font-weight: 600;
  color: var(--text-dim);
  border-bottom: 2px solid var(--border);
  font-size: 0.68rem;
  text-transform: uppercase;
  letter-spacing: 0.04em;
  vertical-align: bottom;
  background: var(--surface);
}
.data-table thead th.num { text-align: right; }
.data-table tbody th {
  text-align: left;
  font-weight: 600;
}
.data-table td.num {
  text-align: right;
  font-family: 'JetBrains Mono', monospace;
}
.data-table td.pos { color: var(--accent); font-weight: 600; }
.data-table td.neg { color: var(--danger, #dc2626); font-weight: 600; }
.data-table tbody tr:hover > * { background: var(--bg); }

.sticky-col {
  position: sticky;
  left: 0;
  z-index: 1;
  background: var(--surface);
  box-shadow: 1px 0 0 var(--border);
  min-width: 11rem;
}
.period-col { min-width: 8.5rem; }
.period-label, .period-btn { display: block; white-space: normal; }
.period-btn {
  margin-left: auto;
  padding: 0;
  border: 0;
  background: none;
  font: inherit;
  color: var(--accent);
  text-transform: inherit;
  letter-spacing: inherit;
  cursor: pointer;
  text-align: right;
}
.period-btn:hover { text-decoration: underline; }
.period-btn:focus-visible { outline: 2px solid var(--accent); outline-offset: 2px; border-radius: 4px; }
.period-badge { margin-top: 0.25rem; }
.total-col {
  background: var(--bg);
  font-weight: 700;
  border-left: 1px solid var(--border);
}
.data-table thead th.total-col { background: var(--bg); }

.row-strong > th, .row-strong > td { font-weight: 700; }
.row-rule > th, .row-rule > td { border-top: 1px solid var(--border); }
.section-row > th {
  font-size: 0.66rem;
  text-transform: uppercase;
  letter-spacing: 0.05em;
  color: var(--text-dim);
  padding-top: 0.75rem;
}
.line-name { font-weight: 500; padding-left: 1.25rem; }
.line-off > th, .line-off > td { color: var(--text-dim); opacity: 0.6; }
.off-chip {
  display: inline-block;
  margin-left: 0.35rem;
  padding: 0.02rem 0.35rem;
  font-size: 0.6rem;
  font-weight: 700;
  letter-spacing: 0.04em;
  text-transform: uppercase;
  color: #475569;
  background: #e2e8f0;
  border-radius: 999px;
  cursor: help;
}
.row-note > th, .row-note > td { font-style: italic; color: var(--text-dim); }
.dim-text { color: var(--text-dim); font-weight: 500; }
.table-foot {
  margin: 0.6rem 0 0;
  font-size: 0.72rem;
  color: var(--text-dim);
  line-height: 1.5;
}
</style>
