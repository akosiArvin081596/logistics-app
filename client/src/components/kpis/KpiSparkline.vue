<template>
  <figure class="kpi-spark">
    <svg
      v-if="spark.hasData"
      class="kpi-spark-svg"
      :viewBox="`0 0 ${spark.width} ${spark.height}`"
      role="img"
      :aria-label="ariaLabel"
    >
      <line
        v-for="gap in spark.gaps"
        :key="`gap-${gap.index}`"
        class="kpi-spark-gap"
        :x1="gap.x"
        :x2="gap.x"
        :y1="spark.height - 7"
        :y2="spark.height - 1"
      >
        <title>{{ monthText(gap.period) }}: {{ gap.display }}</title>
      </line>
      <polyline v-for="(line, i) in spark.lines" :key="`line-${i}`" class="kpi-spark-line" :points="line" />
      <polyline v-if="spark.openLine" class="kpi-spark-line kpi-spark-line--open" :points="spark.openLine" />
      <circle
        v-for="point in spark.points"
        :key="`pt-${point.index}`"
        :class="['kpi-spark-dot', { 'kpi-spark-dot--open': point.index === spark.openIndex }]"
        :cx="point.x"
        :cy="point.y"
        :r="point.index === spark.openIndex ? 2.75 : 1.75"
      >
        <title>{{ monthText(point.period) }}{{ point.index === spark.openIndex ? ' (to date)' : '' }}: {{ point.display }}</title>
      </circle>
    </svg>
    <p v-else class="kpi-spark-empty">No monthly figures to plot yet.</p>
    <figcaption v-if="spark.hasData" class="kpi-spark-caption">
      <span>{{ monthText(spark.first) }}</span>
      <span v-if="spark.gaps.length" class="kpi-spark-legend">
        <span class="kpi-spark-legend-tick" aria-hidden="true"></span>
        No figure that month
      </span>
      <span>{{ monthText(spark.last) }}{{ spark.openIndex >= 0 ? ' (to date)' : '' }}</span>
    </figcaption>
  </figure>
</template>

<script setup>
import { computed } from 'vue'
import { sparkline } from '../../lib/kpiView.js'
import { monthLabel } from '../../lib/monthLabel.js'

// The monthly series as an inline SVG line. There is no chart library in this
// app on purpose (see AiQueryPanel.vue); the points come from lib/kpiView.js,
// which plots each month's value and leaves a gap for a month with none.
const props = defineProps({
  series: { type: Array, default: () => [] },
  label: { type: String, default: '' },
  // The month still in progress ('YYYY-MM'), drawn dashed.
  openPeriod: { type: String, default: '' },
})

const spark = computed(() => sparkline(props.series, { openPeriod: props.openPeriod }))

function monthText(period) {
  return monthLabel(period) || period
}

const ariaLabel = computed(() => {
  const s = spark.value
  const range = `${monthText(s.first)} to ${monthText(s.last)}${s.openIndex >= 0 ? ' (to date)' : ''}`
  const gaps = s.gaps.length ? `; ${s.gaps.length} month${s.gaps.length === 1 ? '' : 's'} without a figure` : ''
  return `${props.label || 'Monthly'} trend, ${range}${gaps}`
})
</script>

<style scoped>
.kpi-spark { margin: 0; }
.kpi-spark-svg {
  display: block;
  width: 100%;
  height: auto;
  overflow: visible;
}
.kpi-spark-line {
  fill: none;
  stroke: var(--accent);
  stroke-width: 1.75;
  stroke-linejoin: round;
  stroke-linecap: round;
}
.kpi-spark-line--open { stroke-dasharray: 3 3; }
.kpi-spark-dot { fill: var(--accent); }
.kpi-spark-dot--open {
  fill: var(--surface);
  stroke: var(--accent);
  stroke-width: 1.5;
}
.kpi-spark-gap {
  stroke: #94a3b8;
  stroke-width: 1.25;
  stroke-dasharray: 2 1.5;
}
.kpi-spark-empty {
  margin: 0;
  padding: 0.75rem 0;
  font-size: 0.75rem;
  color: var(--text-dim);
}
.kpi-spark-caption {
  display: flex;
  justify-content: space-between;
  gap: 0.5rem;
  flex-wrap: wrap;
  margin-top: 0.25rem;
  font-size: 0.68rem;
  color: var(--text-dim);
}
.kpi-spark-legend {
  display: inline-flex;
  align-items: center;
  gap: 0.3rem;
}
.kpi-spark-legend-tick {
  display: inline-block;
  width: 0;
  height: 0.6rem;
  border-left: 1.25px dashed #94a3b8;
}
</style>
