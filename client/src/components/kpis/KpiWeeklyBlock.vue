<template>
  <section v-if="view" class="kpi-weekly" :aria-labelledby="headingId">
    <h5 :id="headingId" class="kpi-weekly-title">{{ WEEKLY_TITLE }}</h5>
    <p v-if="view.mode !== 'weekly'" class="kpi-weekly-note">{{ view.reason }}</p>
    <template v-else>
      <p v-if="!view.lastWeek && !view.toDate" class="kpi-weekly-note">No weekly figures yet; the next KPI run stores them.</p>
      <dl v-else class="kpi-weekly-pairs">
        <div v-if="view.lastWeek" class="kpi-weekly-pair">
          <dt>Last week ({{ view.lastWeek.label }})</dt>
          <dd :class="{ 'kpi-weekly-muted': view.lastWeek.muted }">{{ view.lastWeek.display }}</dd>
        </div>
        <div v-if="view.comparison" class="kpi-weekly-pair">
          <dt>{{ view.comparison.label }}</dt>
          <dd :class="{ 'kpi-weekly-muted': view.comparison.muted }">{{ view.comparison.display }}</dd>
        </div>
        <div v-if="view.toDate" class="kpi-weekly-pair">
          <dt>This week so far ({{ view.toDate.label }})</dt>
          <dd :class="{ 'kpi-weekly-muted': view.toDate.muted }">{{ view.toDate.display }}</dd>
        </div>
      </dl>
      <p v-if="view.comparison?.note" class="kpi-weekly-note">{{ view.comparison.note }}</p>
      <figure v-if="spark.hasData" class="kpi-weekly-spark">
        <svg class="kpi-weekly-svg" :viewBox="`0 0 ${spark.width} ${spark.height}`" role="img" :aria-label="ariaLabel">
          <line
            v-for="gap in spark.gaps"
            :key="`gap-${gap.index}`"
            class="kpi-weekly-gap"
            :x1="gap.x"
            :x2="gap.x"
            :y1="spark.height - 7"
            :y2="spark.height - 1"
          >
            <title>{{ gap.period }}: {{ gap.display }}</title>
          </line>
          <polyline v-for="(line, i) in spark.lines" :key="`line-${i}`" class="kpi-weekly-line" :points="line" />
          <polyline v-if="spark.openLine" class="kpi-weekly-line kpi-weekly-line--open" :points="spark.openLine" />
          <circle
            v-for="point in spark.points"
            :key="`pt-${point.index}`"
            :class="['kpi-weekly-dot', { 'kpi-weekly-dot--open': point.index === spark.openIndex }]"
            :cx="point.x"
            :cy="point.y"
            :r="point.index === spark.openIndex ? 2.75 : 1.75"
          >
            <title>{{ point.period }}: {{ point.display }}</title>
          </circle>
        </svg>
        <figcaption class="kpi-weekly-caption">
          <span>{{ spark.first }}</span>
          <span>{{ spark.last }}</span>
        </figcaption>
      </figure>
    </template>
    <p v-if="view.rule" class="kpi-weekly-rule">{{ view.rule }}</p>
  </section>
</template>

<script setup>
import { computed } from 'vue'
import { WEEKLY_TITLE, sparkline, weeklyView } from '../../lib/kpiView.js'

// One metric's weekly block from GET /api/admin/kpis (present only while weekly
// figures are on). Every label and figure is a server string; the sparkline
// plots each week's value, leaves a gap for a week with none and draws the
// week to date dashed.
const props = defineProps({
  weekly: { type: Object, default: null },
  label: { type: String, default: '' },
  metricKey: { type: String, required: true },
})

const view = computed(() => weeklyView(props.weekly))
const headingId = computed(() => `kpi-${props.metricKey}-weekly`)
const spark = computed(() => sparkline(view.value ? view.value.points : [], { openPeriod: view.value ? view.value.openPeriod : '' }))
const ariaLabel = computed(() => {
  const s = spark.value
  const gaps = s.gaps.length ? `; ${s.gaps.length} week${s.gaps.length === 1 ? '' : 's'} without a figure` : ''
  return `${props.label || 'Weekly'} by week, ${s.first} to ${s.last}${gaps}`
})
</script>

<style scoped>
.kpi-weekly { display: flex; flex-direction: column; gap: 0.3rem; }
.kpi-weekly-title {
  margin: 0.25rem 0 0.15rem;
  font-size: 0.7rem;
  font-weight: 700;
  text-transform: uppercase;
  letter-spacing: 0.05em;
  color: var(--text-dim);
}
.kpi-weekly-pairs {
  display: flex;
  flex-direction: column;
  gap: 0.2rem;
  margin: 0;
  font-size: 0.8rem;
}
.kpi-weekly-pair {
  display: flex;
  justify-content: space-between;
  gap: 0.75rem;
}
.kpi-weekly-pair dt { min-width: 0; overflow-wrap: anywhere; }
.kpi-weekly-pair dd {
  margin: 0;
  font-weight: 600;
  text-align: right;
  font-variant-numeric: tabular-nums;
  overflow-wrap: anywhere;
}
.kpi-weekly-muted { color: var(--text-dim); font-weight: 500; }
.kpi-weekly-note,
.kpi-weekly-rule {
  margin: 0;
  font-size: 0.74rem;
  color: var(--text-dim);
}
.kpi-weekly-spark { margin: 0; }
.kpi-weekly-svg {
  display: block;
  width: 100%;
  height: auto;
  overflow: visible;
}
.kpi-weekly-line {
  fill: none;
  stroke: var(--accent);
  stroke-width: 1.75;
  stroke-linejoin: round;
  stroke-linecap: round;
}
.kpi-weekly-line--open { stroke-dasharray: 3 3; }
.kpi-weekly-dot { fill: var(--accent); }
.kpi-weekly-dot--open {
  fill: var(--surface);
  stroke: var(--accent);
  stroke-width: 1.5;
}
.kpi-weekly-gap {
  stroke: #94a3b8;
  stroke-width: 1.25;
  stroke-dasharray: 2 1.5;
}
.kpi-weekly-caption {
  display: flex;
  justify-content: space-between;
  gap: 0.5rem;
  flex-wrap: wrap;
  margin-top: 0.25rem;
  font-size: 0.68rem;
  color: var(--text-dim);
}
</style>
