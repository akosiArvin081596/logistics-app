<template>
  <section class="kpi-job" aria-label="Snapshot and digest status">
    <div class="kpi-job-item">
      <div class="kpi-job-label">Last run</div>
      <template v-if="lastRun">
        <div class="kpi-job-main">
          <KpiBadge :label="runStatus.label" :tone="runStatus.tone" />
          <span>{{ runKindLabel(lastRun.kind) }}</span>
        </div>
        <div class="kpi-job-sub">
          Started {{ fmtAppInstant(lastRun.startedAt) }}<template v-if="duration"> · <span class="kpi-nowrap">took {{ duration }}</span></template>
        </div>
        <div v-if="runErrors.length" class="kpi-job-errors">
          {{ runErrors.length === 1 ? 'One metric could not be computed' : `${runErrors.length} metrics could not be computed` }}:
          <span v-for="(e, i) in runErrors" :key="i">{{ i ? ', ' : '' }}{{ e.label }} ({{ e.code }})</span>
        </div>
      </template>
      <div v-else class="kpi-job-main kpi-job-none">No run yet</div>
    </div>

    <div class="kpi-job-item">
      <div class="kpi-job-label">Next snapshot</div>
      <div class="kpi-job-main">
        <template v-if="job.enabled?.snapshot">{{ fmtAppInstant(job.nextSnapshotAt, { fallback: 'Not scheduled' }) }}</template>
        <KpiBadge v-else label="Switched off" tone="missing" />
      </div>
      <div class="kpi-job-sub">{{ job.snapshotSchedule }}</div>
    </div>

    <div class="kpi-job-item">
      <div class="kpi-job-label">Next weekly digest</div>
      <div class="kpi-job-main">
        <template v-if="job.enabled?.digest">{{ fmtAppInstant(job.nextDigestAt, { fallback: 'Not scheduled' }) }}</template>
        <KpiBadge v-else label="Switched off" tone="missing" />
      </div>
      <div class="kpi-job-sub">{{ job.digestSchedule }}</div>
      <div v-if="job.lastDigest" class="kpi-job-sub">
        Last digest: {{ digestStatusBadge(job.lastDigest.status).label }}<template v-if="job.lastDigest.at"> {{ fmtAppInstant(job.lastDigest.at) }}</template>
      </div>
    </div>

    <div class="kpi-job-item">
      <div class="kpi-job-label">Preview digest</div>
      <div class="kpi-job-main">
        <KpiBadge :label="preview.label" :tone="preview.tone" />
      </div>
      <div class="kpi-job-sub">
        <template v-if="job.preview?.at">{{ fmtAppInstant(job.preview.at) }} · </template>One copy to the admin inbox after the first snapshot, marked “not approved for public use”.
      </div>
    </div>
  </section>
</template>

<script setup>
import { computed } from 'vue'
import KpiBadge from './KpiBadge.vue'
import { digestStatusBadge, durationText, runKindLabel, runStatusBadge } from '../../lib/kpiView.js'
import { fmtAppInstant } from '../../utils/datetime'

// The `job` block of GET /api/admin/kpis. Every time is an ISO instant from the
// server, shown in the app zone with its label (utils/datetime.js).
const props = defineProps({
  job: { type: Object, required: true },
  metrics: { type: Array, default: () => [] },
})

const lastRun = computed(() => props.job.lastRun || null)
const runStatus = computed(() => runStatusBadge(lastRun.value?.status))
const duration = computed(() => durationText(lastRun.value?.durationMs))
const preview = computed(() => digestStatusBadge(props.job.preview?.status))

// A run's errors name the metric by key and say what went wrong as a code; the
// card's label is shown in place of the key.
const runErrors = computed(() => (Array.isArray(lastRun.value?.errors) ? lastRun.value.errors : []).map((e) => ({
  label: props.metrics.find((m) => m.key === e?.metric)?.label || String(e?.metric ?? 'Unknown'),
  code: String(e?.code ?? ''),
})))
</script>

<style scoped>
.kpi-job {
  display: grid;
  grid-template-columns: 1fr;
  gap: 0.75rem;
  margin-bottom: 1.25rem;
}
@media (min-width: 640px) {
  .kpi-job { grid-template-columns: repeat(2, minmax(0, 1fr)); }
}
@media (min-width: 1200px) {
  .kpi-job { grid-template-columns: repeat(4, minmax(0, 1fr)); }
}
.kpi-job-item {
  min-width: 0;
  padding: 0.75rem 0.9rem;
  border: 1px solid #e8edf2;
  border-radius: 12px;
  background: var(--surface);
  box-shadow: var(--shadow-card);
}
.kpi-job-label {
  font-size: 0.68rem;
  font-weight: 700;
  text-transform: uppercase;
  letter-spacing: 0.05em;
  color: var(--text-dim);
  margin-bottom: 0.35rem;
}
.kpi-job-main {
  display: flex;
  flex-wrap: wrap;
  align-items: center;
  gap: 0.4rem;
  font-size: 0.86rem;
  font-weight: 600;
  color: var(--text);
}
.kpi-job-none { color: var(--text-dim); font-weight: 500; }
.kpi-nowrap { white-space: nowrap; }
.kpi-job-sub {
  margin-top: 0.3rem;
  font-size: 0.74rem;
  color: var(--text-dim);
  overflow-wrap: anywhere;
}
.kpi-job-errors {
  margin-top: 0.35rem;
  font-size: 0.74rem;
  color: #b91c1c;
  overflow-wrap: anywhere;
}
</style>
