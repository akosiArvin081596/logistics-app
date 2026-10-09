<template>
  <Card class="kpi-metric" :aria-labelledby="titleId" role="group">
    <CardContent class="kpi-metric-body">
      <header class="kpi-metric-head">
        <h4 :id="titleId" class="kpi-metric-title">{{ metric.label }}</h4>
        <div class="kpi-metric-badges">
          <KpiBadge :label="kind.label" :tone="kind.tone" />
          <KpiBadge v-if="metric.status === 'partial'" :label="PARTIAL_BADGE.label" :tone="PARTIAL_BADGE.tone" />
          <KpiBadge v-if="metric.confidence !== 'none'" :label="confidence.label" :tone="confidence.tone" />
        </div>
      </header>

      <div class="kpi-metric-figure">
        <div class="kpi-metric-value" :class="{ 'kpi-metric-value--none': !hasFigure }">{{ metric.display }}</div>
        <div v-if="metric.current?.label" class="kpi-metric-period">{{ metric.current.label }}</div>
      </div>
      <p v-if="metric.missingReason" class="kpi-metric-missing">{{ metric.missingReason }}</p>

      <ul v-if="metric.warnings?.length" class="kpi-warnings" role="note" aria-label="Warnings">
        <li v-for="(w, i) in metric.warnings" :key="i">
          <TriangleAlert class="kpi-warn-icon" aria-hidden="true" />
          <span>{{ w }}</span>
        </li>
      </ul>

      <dl v-if="metric.totals?.length" class="kpi-pairs">
        <div v-for="t in metric.totals" :key="t.label" class="kpi-pair">
          <dt>{{ t.label }}</dt>
          <dd>{{ t.display }}</dd>
        </div>
      </dl>

      <KpiSparkline :series="metric.series || []" :label="metric.label" :open-period="openPeriod" />

      <section v-if="comparisons.length" class="kpi-block" :aria-labelledby="`${titleId}-cmp`">
        <h5 :id="`${titleId}-cmp`" class="kpi-block-title">Compared with</h5>
        <ul class="kpi-list">
          <li v-for="(c, i) in comparisons" :key="i" :class="{ 'kpi-muted': c.muted }">
            <span class="kpi-list-label">{{ c.label }}</span>
            <span class="kpi-list-value">{{ c.display }}</span>
          </li>
        </ul>
      </section>

      <section v-if="beforeAfter.length" class="kpi-block" :aria-labelledby="`${titleId}-ba`">
        <h5 :id="`${titleId}-ba`" class="kpi-block-title">Before and after</h5>
        <ul class="kpi-ba-list">
          <li v-for="(row, i) in beforeAfter" :key="i" class="kpi-ba" :class="{ 'kpi-muted': row.muted }">
            <div class="kpi-ba-head">
              <strong>{{ row.event }}</strong>
              <span class="kpi-ba-date">{{ row.dateText }}</span>
              <KpiBadge v-if="row.statusLabel && row.statusLabel !== row.dateText" :label="row.statusLabel" tone="muted" />
            </div>
            <div v-if="row.hasSides" class="kpi-ba-sides">
              <span>Before <strong>{{ row.before || '—' }}</strong></span>
              <span aria-hidden="true">→</span>
              <span>After <strong>{{ row.after || '—' }}</strong></span>
              <span v-if="row.display && row.display !== row.statusLabel" class="kpi-ba-change">{{ row.display }}</span>
            </div>
            <div v-else-if="row.display && row.display !== row.statusLabel" class="kpi-ba-sides">{{ row.display }}</div>
            <p v-if="row.note" class="kpi-ba-note">{{ row.note }}</p>
          </li>
        </ul>
      </section>

      <p v-if="coverage" class="kpi-coverage">
        <span class="kpi-coverage-label">Coverage</span>
        {{ coverage }}<template v-if="coverageRange">, {{ coverageRange }}</template>
      </p>

      <section v-if="metric.assumptions?.length" class="kpi-block" :aria-labelledby="`${titleId}-asm`">
        <h5 :id="`${titleId}-asm`" class="kpi-block-title">Assumptions</h5>
        <ul class="kpi-bullets">
          <li v-for="(a, i) in metric.assumptions" :key="i">{{ a }}</li>
        </ul>
      </section>

      <KpiApprovalToggle :metric="metric" :saving="saving" @set="(e) => emit('set-approval', e)" />

      <details class="kpi-details">
        <summary>Definition, source and monthly figures</summary>
        <p class="kpi-definition">{{ metric.definition }}</p>
        <p class="kpi-detail-meta">
          Definition version {{ metric.definitionVersion }}<template v-if="metric.computedDay"> · computed for {{ fmtYmd(metric.computedDay) }}</template>
        </p>
        <p v-if="metric.source?.url" class="kpi-source">
          Source:
          <a :href="metric.source.url" target="_blank" rel="noopener noreferrer">
            {{ metric.source.label || metric.source.url }}
            <ExternalLink class="kpi-ext-icon" aria-hidden="true" />
            <span class="sr-only">(opens in a new tab)</span>
          </a>
        </p>
        <p v-else-if="metric.source?.label" class="kpi-source">Source: {{ metric.source.label }}</p>

        <template v-if="metric.breakdown?.length">
          <h5 class="kpi-block-title">Breakdown</h5>
          <ul class="kpi-list">
            <li v-for="(b, i) in metric.breakdown" :key="i">
              <span class="kpi-list-label">{{ b.label }}</span>
              <span class="kpi-list-value">{{ b.display }}</span>
            </li>
          </ul>
        </template>

        <template v-if="metric.series?.length">
          <h5 class="kpi-block-title">By month</h5>
          <ul class="kpi-list kpi-months">
            <li v-for="p in metric.series" :key="p.period" :class="{ 'kpi-muted': p.value === null }">
              <span class="kpi-list-label">{{ monthLabel(p.period) || p.period }}</span>
              <span class="kpi-list-value">{{ p.display }}</span>
            </li>
          </ul>
        </template>
      </details>
    </CardContent>
  </Card>
</template>

<script setup>
import { computed } from 'vue'
import { ExternalLink, TriangleAlert } from 'lucide-vue-next'
import { Card, CardContent } from '@/components/ui/card'
import KpiBadge from './KpiBadge.vue'
import KpiSparkline from './KpiSparkline.vue'
import KpiApprovalToggle from './KpiApprovalToggle.vue'
import {
  PARTIAL_BADGE, beforeAfterRow, comparisonRow, confidenceBadge, coverageText, kindBadge,
} from '../../lib/kpiView.js'
import { monthLabel } from '../../lib/monthLabel.js'
import { fmtYmd } from '../../utils/datetime'

// One metric from GET /api/admin/kpis. Every figure on it is a display string
// the server built; this card lays them out and never works one out.
const props = defineProps({
  metric: { type: Object, required: true },
  saving: { type: Boolean, default: false },
  // The as-of month ('YYYY-MM'), still in progress.
  openPeriod: { type: String, default: '' },
})
const emit = defineEmits(['set-approval'])

const titleId = computed(() => `kpi-${props.metric.key}`)
const kind = computed(() => kindBadge(props.metric))
const confidence = computed(() => confidenceBadge(props.metric.confidence))
const hasFigure = computed(() => props.metric.value !== null && props.metric.value !== undefined)
const comparisons = computed(() => (props.metric.comparisons || []).map(comparisonRow))
const beforeAfter = computed(() => (props.metric.beforeAfter || []).map((row) => beforeAfterRow(row, (d) => fmtYmd(d))))
const coverage = computed(() => coverageText(props.metric.coverage))
const coverageRange = computed(() => {
  const c = props.metric.coverage
  if (!c?.from && !c?.to) return ''
  return `${fmtYmd(c.from, { fallback: '…' })} to ${fmtYmd(c.to, { fallback: '…' })}`
})
</script>

<style scoped>
.kpi-metric {
  border-radius: 14px;
  border-color: #e8edf2;
  box-shadow: var(--shadow-card);
  min-width: 0;
}
.kpi-metric-body {
  display: flex;
  flex-direction: column;
  gap: 0.75rem;
  padding: 1rem 1.1rem 1.1rem;
  min-width: 0;
}
.kpi-metric-head {
  display: flex;
  flex-direction: column;
  gap: 0.4rem;
}
.kpi-metric-title {
  margin: 0;
  font-size: 0.9rem;
  font-weight: 700;
  color: var(--text);
  overflow-wrap: anywhere;
}
.kpi-metric-badges {
  display: flex;
  flex-wrap: wrap;
  gap: 0.35rem;
}
.kpi-metric-figure {
  display: flex;
  align-items: baseline;
  flex-wrap: wrap;
  gap: 0.25rem 0.6rem;
}
.kpi-metric-value {
  font-size: 1.6rem;
  font-weight: 700;
  line-height: 1.15;
  color: var(--text);
  font-variant-numeric: tabular-nums;
  overflow-wrap: anywhere;
}
.kpi-metric-value--none {
  font-size: 1.1rem;
  color: var(--text-dim);
}
.kpi-metric-period {
  font-size: 0.78rem;
  color: var(--text-dim);
}
.kpi-metric-missing {
  margin: -0.35rem 0 0;
  font-size: 0.78rem;
  color: #b91c1c;
}
.kpi-warnings {
  margin: 0;
  padding: 0.55rem 0.7rem;
  list-style: none;
  border: 1px solid #fcd34d;
  border-left-width: 4px;
  border-radius: 8px;
  background: #fffbeb;
  color: #78350f;
  font-size: 0.78rem;
  font-weight: 600;
}
.kpi-warnings li {
  display: flex;
  gap: 0.45rem;
  align-items: flex-start;
}
.kpi-warnings li + li { margin-top: 0.35rem; }
.kpi-warn-icon {
  width: 15px;
  height: 15px;
  flex: none;
  margin-top: 0.1rem;
  color: #b45309;
}
.kpi-pairs {
  display: flex;
  flex-wrap: wrap;
  gap: 0.35rem 1.25rem;
  margin: 0;
}
.kpi-pair dt {
  font-size: 0.68rem;
  text-transform: uppercase;
  letter-spacing: 0.04em;
  color: var(--text-dim);
}
.kpi-pair dd {
  margin: 0;
  font-size: 0.86rem;
  font-weight: 600;
  font-variant-numeric: tabular-nums;
}
.kpi-block { display: flex; flex-direction: column; gap: 0.3rem; }
.kpi-block-title {
  margin: 0.25rem 0 0.15rem;
  font-size: 0.7rem;
  font-weight: 700;
  text-transform: uppercase;
  letter-spacing: 0.05em;
  color: var(--text-dim);
}
.kpi-list {
  margin: 0;
  padding: 0;
  list-style: none;
  font-size: 0.8rem;
}
.kpi-list li {
  display: flex;
  justify-content: space-between;
  gap: 0.75rem;
  padding: 0.2rem 0;
  border-bottom: 1px dashed #eef0f4;
}
.kpi-list li:last-child { border-bottom: 0; }
.kpi-list-label { min-width: 0; overflow-wrap: anywhere; }
.kpi-list-value {
  font-weight: 600;
  text-align: right;
  font-variant-numeric: tabular-nums;
  overflow-wrap: anywhere;
}
.kpi-muted { color: var(--text-dim); }
.kpi-muted .kpi-list-value { font-weight: 500; }
.kpi-ba-list {
  margin: 0;
  padding: 0;
  list-style: none;
  display: flex;
  flex-direction: column;
  gap: 0.5rem;
}
.kpi-ba {
  padding: 0.5rem 0.6rem;
  border: 1px solid var(--border);
  border-radius: 8px;
  font-size: 0.8rem;
}
.kpi-ba-head {
  display: flex;
  flex-wrap: wrap;
  align-items: center;
  gap: 0.35rem 0.6rem;
}
.kpi-ba-date { color: var(--text-dim); }
.kpi-ba-sides {
  display: flex;
  flex-wrap: wrap;
  align-items: baseline;
  gap: 0.25rem 0.5rem;
  margin-top: 0.3rem;
  font-variant-numeric: tabular-nums;
}
.kpi-ba-change { font-weight: 700; }
.kpi-ba-note {
  margin: 0.3rem 0 0;
  font-size: 0.74rem;
  color: var(--text-dim);
}
.kpi-coverage {
  margin: 0;
  font-size: 0.78rem;
  color: var(--text);
  overflow-wrap: anywhere;
}
.kpi-coverage-label {
  margin-right: 0.35rem;
  font-size: 0.68rem;
  font-weight: 700;
  text-transform: uppercase;
  letter-spacing: 0.05em;
  color: var(--text-dim);
}
.kpi-details {
  border-top: 1px solid var(--border);
  padding-top: 0.6rem;
  font-size: 0.8rem;
}
.kpi-details summary {
  cursor: pointer;
  font-weight: 600;
  color: #0369a1;
}
.kpi-details summary:focus-visible { outline: 2px solid var(--accent); outline-offset: 2px; border-radius: 4px; }
.kpi-definition { margin: 0.6rem 0 0.25rem; }
.kpi-detail-meta {
  margin: 0 0 0.4rem;
  font-size: 0.72rem;
  color: var(--text-dim);
}
.kpi-source { margin: 0 0 0.4rem; overflow-wrap: anywhere; }
.kpi-source a {
  color: #0369a1;
  text-decoration: underline;
  text-underline-offset: 2px;
}
.kpi-ext-icon {
  display: inline;
  width: 12px;
  height: 12px;
  vertical-align: -1px;
}
.kpi-bullets {
  margin: 0;
  padding-left: 1.1rem;
  list-style: disc;
  font-size: 0.78rem;
}
.kpi-bullets li + li { margin-top: 0.2rem; }
.kpi-months { max-height: 14rem; overflow-y: auto; }
</style>
