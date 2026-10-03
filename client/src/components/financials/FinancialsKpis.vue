<template>
  <div class="kpis">
    <div v-if="pending && pending.count > 0" class="data-warning" role="status">
      <div class="data-warning-title">Pending review</div>
      <div class="data-warning-msg">
        <strong>{{ formatCount(pending.count) }}</strong> receipt{{ pending.count === 1 ? '' : 's' }},
        <strong>{{ formatMoney(pending.amount) }}</strong><template v-if="pending.oldestDays != null">,
        oldest {{ formatCount(pending.oldestDays) }} day{{ pending.oldestDays === 1 ? '' : 's' }}</template>
        — counted in the figures below.
      </div>
    </div>

    <section class="section" aria-labelledby="fin-kpi-title">
      <div class="section-title">
        <div class="section-icon" style="background: var(--accent-dim); color: var(--accent);" aria-hidden="true">$</div>
        <h3 id="fin-kpi-title" class="section-heading">Summary</h3>
        <span class="section-sub">{{ caption }}</span>
      </div>

      <div class="kpi-grid">
        <div class="kpi-card">
          <div class="kpi-label">Revenue</div>
          <div class="kpi-value">{{ formatMoney(total.revenue) }}</div>
          <div class="kpi-sub">Completed loads in range</div>
        </div>
        <div class="kpi-card">
          <div class="kpi-label">Total costs</div>
          <div class="kpi-value">{{ formatMoney(total.totalCosts) }}</div>
          <div class="kpi-sub">Cost lines switched on</div>
        </div>
        <div class="kpi-card" :class="marginClass">
          <div class="kpi-label">Margin</div>
          <div class="kpi-value">{{ formatMoney(total.margin) }}</div>
          <div class="kpi-sub">Revenue less total costs</div>
        </div>
        <div class="kpi-card" :class="marginClass">
          <div class="kpi-label">Margin %</div>
          <div class="kpi-value">{{ formatPct(total.marginPct) }}</div>
          <div class="kpi-sub">{{ total.marginPct == null ? 'No revenue in range' : 'Of revenue' }}</div>
        </div>
      </div>
      <div class="kpi-grid kpi-grid-ops">
        <div class="kpi-card">
          <div class="kpi-label">Loads</div>
          <div class="kpi-value">{{ formatCount(total.loads) }}</div>
          <div class="kpi-sub">{{ formatCount(total.loadsWithMiles) }} with miles recorded</div>
        </div>
        <div class="kpi-card">
          <div class="kpi-label">Miles</div>
          <div class="kpi-value">{{ formatCount(total.miles) }}</div>
          <div class="kpi-sub">ELD where recorded, else estimates</div>
        </div>
        <div class="kpi-card">
          <div class="kpi-label">Revenue / mile</div>
          <div class="kpi-value">{{ formatPerMile(total.revenuePerMile) }}</div>
          <div class="kpi-sub">Cost / mile {{ formatPerMile(total.costPerMile) }}</div>
        </div>
      </div>

      <p v-if="hasSettlement" class="kpi-note">
        Includes settlement adjustments of <strong>{{ formatMoney(total.settlementAdjustment) }}</strong>
        (closed months shown as settled).
      </p>
      <p v-if="report.overlaps > 0" class="kpi-note">
        {{ formatCount(report.overlaps) }} item{{ report.overlaps === 1 ? ' is' : 's are' }} claimed by two investors;
        each investor's figures count {{ report.overlaps === 1 ? 'it' : 'them' }}, so the fleet does too.
      </p>
    </section>
  </div>
</template>

<script setup>
import { computed } from 'vue'
import { fmtYmd, fmtTimestamp } from '../../utils/datetime'
import { formatCount, formatMoney, formatPct, formatPerMile, signClass, GRANULARITIES } from '../../lib/financialsView'

// The report's headline figures, straight from `report.total`.
const props = defineProps({
  report: { type: Object, required: true },
})

const total = computed(() => props.report.total || {})
const pending = computed(() => props.report.pendingReceipts || null)
const hasSettlement = computed(() => Number(total.value.settlementAdjustment) !== 0 && total.value.settlementAdjustment != null)
const marginClass = computed(() => {
  const s = signClass(total.value.margin)
  return s === 'pos' ? 'kpi-pos' : s === 'neg' ? 'kpi-neg' : ''
})

const caption = computed(() => {
  const r = props.report
  const gran = GRANULARITIES.find((g) => g.key === r.granularity)
  const parts = [`${fmtYmd(r.from)} – ${fmtYmd(r.to)}`]
  if (gran) parts.push(`by ${gran.label.toLowerCase()}${gran.hint ? ` (${gran.hint})` : ''}`)
  const closed = Array.isArray(r.closedMonths) ? r.closedMonths.length : 0
  if (closed) parts.push(`${closed} closed month${closed === 1 ? '' : 's'} shown as settled`)
  if (r.generatedAt) parts.push(`as of ${fmtTimestamp(r.generatedAt)}`)
  return parts.join(' · ')
})
</script>

<style scoped>
.kpis { display: flex; flex-direction: column; gap: 1rem; }
.section {
  background: var(--surface);
  border: 1px solid var(--border);
  border-radius: 12px;
  padding: 1.25rem;
}
.section-title {
  display: flex;
  flex-wrap: wrap;
  align-items: center;
  gap: 0.6rem;
  margin-bottom: 1rem;
}
.section-heading { font-weight: 700; font-size: 0.95rem; margin: 0; }
.section-icon {
  width: 28px; height: 28px; border-radius: 8px;
  display: flex; align-items: center; justify-content: center;
  font-size: 0.85rem; font-weight: 700;
}
.section-sub {
  margin-left: auto;
  font-size: 0.72rem;
  font-weight: 500;
  color: var(--text-dim);
}
.kpi-grid {
  display: grid;
  grid-template-columns: repeat(4, minmax(0, 1fr));
  gap: 0.75rem;
}
.kpi-grid-ops {
  grid-template-columns: repeat(3, minmax(0, 1fr));
  margin-top: 0.75rem;
}
.kpi-card {
  background: var(--bg);
  border: 1px solid var(--border);
  border-radius: 10px;
  padding: 0.9rem 1rem;
  display: flex;
  flex-direction: column;
  gap: 0.25rem;
  min-width: 0;
}
.kpi-card.kpi-pos { border-left: 3px solid var(--accent); }
.kpi-card.kpi-neg { border-left: 3px solid var(--danger, #dc2626); }
.kpi-label {
  font-size: 0.68rem; font-weight: 600;
  color: var(--text-dim); text-transform: uppercase;
  letter-spacing: 0.05em;
}
.kpi-value {
  font-size: 1.2rem; font-weight: 700;
  font-family: 'JetBrains Mono', monospace;
  overflow-wrap: anywhere;
}
.kpi-card.kpi-pos .kpi-value { color: var(--accent); }
.kpi-card.kpi-neg .kpi-value { color: var(--danger, #dc2626); }
.kpi-sub { font-size: 0.7rem; color: var(--text-dim); }
.kpi-note {
  margin: 0.85rem 0 0;
  font-size: 0.75rem;
  color: var(--text-dim);
}
.data-warning {
  background: #fef3c7;
  border: 1px solid #fcd34d;
  border-left: 4px solid #f59e0b;
  border-radius: 10px;
  padding: 0.85rem 1rem;
  color: #78350f;
}
.data-warning-title { font-weight: 700; font-size: 0.85rem; margin-bottom: 0.35rem; }
.data-warning-msg { font-size: 0.78rem; line-height: 1.5; }

@media (max-width: 1099px) {
  .kpi-grid { grid-template-columns: repeat(2, minmax(0, 1fr)); }
  .kpi-grid-ops { grid-template-columns: repeat(3, minmax(0, 1fr)); }
}
@media (max-width: 767px) {
  .kpi-grid, .kpi-grid-ops { grid-template-columns: 1fr; }
  .section-sub { margin-left: 0; width: 100%; }
}
</style>
