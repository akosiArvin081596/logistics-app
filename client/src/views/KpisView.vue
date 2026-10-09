<template>
  <div class="kpis-page admin-page" style="overflow-y:auto;min-height:auto;flex:none;">
    <div class="page-header kpis-header">
      <div class="kpis-heading">
        <h2>KPIs</h2>
        <p class="kpis-desc">Company KPIs computed nightly from the app's own data. Aggregated figures only.</p>
      </div>
      <Button
        type="button"
        class="text-[12px]"
        :disabled="store.recomputeStarting || running"
        @click="store.recompute()"
      >
        <RefreshCw :class="{ 'animate-spin': store.recomputeStarting || running }" aria-hidden="true" />
        {{ running ? 'Run in progress…' : 'Recompute now' }}
      </Button>
    </div>

    <p class="kpis-banner" role="note">
      <ShieldAlert class="kpis-banner-icon" aria-hidden="true" />
      <span>Nothing on this page is public. A metric may be published only when it shows ‘Approved for public use: Yes’.</span>
    </p>

    <!-- The skeleton is for the first read only, so a live update never unmounts
         the cards (and an open confirm dialog with them). -->
    <template v-if="store.isLoading && !store.hasLoaded">
      <SkeletonLoader :rows="4" :cols="4" />
    </template>
    <div v-else-if="!store.hasLoaded && store.loadError" class="load-error" role="alert">
      <span>Couldn't load the KPIs ({{ store.loadError }}).</span>
      <button type="button" class="btn btn-secondary btn-sm" @click="store.refresh()">Retry</button>
    </div>
    <template v-else-if="store.report">
      <p v-if="store.loadError" class="load-error" role="alert">
        <span>Couldn't refresh the KPIs ({{ store.loadError }}). These are the figures as last loaded.</span>
        <button type="button" class="btn btn-secondary btn-sm" @click="store.refresh()">Retry</button>
      </p>

      <p class="kpis-asof">
        Figures as of {{ fmtYmd(store.report.asOfDay) }}<template v-if="store.report.generatedAt"> · loaded {{ fmtAppInstant(store.report.generatedAt) }}</template>
      </p>

      <KpiJobStatus v-if="store.job" :job="store.job" :metrics="store.metrics" />

      <KpiSettingsPanel v-if="store.settings" :settings="store.settings" />

      <p v-if="!store.metrics.length" class="kpis-empty">
        No KPI snapshot yet. The first one is taken at the next scheduled run, or with “Recompute now”.
      </p>

      <section
        v-for="group in groups"
        :key="group.key"
        class="kpis-group"
        :aria-labelledby="`kpis-group-${group.key}`"
      >
        <h3 :id="`kpis-group-${group.key}`" class="kpis-group-title">{{ group.label }}</h3>
        <div class="kpi-grid kpis-grid">
          <KpiMetricCard
            v-for="metric in group.metrics"
            :key="metric.key"
            :metric="metric"
            :saving="!!store.approvalSaving[metric.key]"
            :open-period="openPeriod"
            @set-approval="(e) => store.setApproval(e.key, e.approved, e.definitionVersion)"
          />
        </div>
      </section>
    </template>
  </div>
</template>

<script setup>
import { computed, onUnmounted, watch } from 'vue'
import { RefreshCw, ShieldAlert } from 'lucide-vue-next'
import { useKpisStore } from '../stores/kpis'
import { useSocketRefresh } from '../composables/useSocketRefresh'
import { groupMetrics } from '../lib/kpiView.js'
import { fmtAppInstant, fmtYmd } from '../utils/datetime'
import { Button } from '@/components/ui/button'
import SkeletonLoader from '../components/shared/SkeletonLoader.vue'
import KpiJobStatus from '../components/kpis/KpiJobStatus.vue'
import KpiSettingsPanel from '../components/kpis/KpiSettingsPanel.vue'
import KpiMetricCard from '../components/kpis/KpiMetricCard.vue'

// The admin KPI page: GET /api/admin/kpis as the server sent it. Super Admin only
// (router meta and requireRole on every route). Nothing here is public; each
// metric carries its own "Approved for public use" flag.
const store = useKpisStore()
useSocketRefresh('kpis:changed', () => store.refresh())

// Started during setup, not on mount, so the first render already shows the skeleton.
store.refresh()

const groups = computed(() => groupMetrics(store.metrics))
// The as-of day's month is still in progress; its sparkline step is drawn dashed.
const openPeriod = computed(() => String(store.report?.asOfDay || '').slice(0, 7))
const running = computed(() => store.job?.lastRun?.status === 'running')

// While a run is going, read the page again every 10 s until it finishes, in
// case its end arrives without a live update. The run is time-boxed on the
// server, so this stops on its own.
const RUNNING_RECHECK_MS = 10_000
let recheck = null
watch(() => store.report, () => {
  clearTimeout(recheck)
  recheck = running.value ? setTimeout(() => store.refresh(), RUNNING_RECHECK_MS) : null
})
onUnmounted(() => clearTimeout(recheck))
</script>

<style scoped>
.kpis-header { align-items: flex-start; }
.kpis-heading { min-width: 0; }
.kpis-desc {
  margin: 0.25rem 0 0;
  font-size: 0.82rem;
  color: var(--text-dim);
}
.kpis-banner {
  display: flex;
  align-items: flex-start;
  gap: 0.55rem;
  margin: 0 0 1rem;
  padding: 0.7rem 0.9rem;
  border: 1px solid #fcd34d;
  border-left-width: 4px;
  border-radius: var(--radius);
  background: #fffbeb;
  color: #78350f;
  font-size: 0.82rem;
  font-weight: 600;
}
.kpis-banner-icon {
  width: 18px;
  height: 18px;
  flex: none;
  margin-top: 0.05rem;
  color: #b45309;
}
.kpis-asof {
  margin: 0 0 0.75rem;
  font-size: 0.76rem;
  color: var(--text-dim);
}
.kpis-empty {
  padding: 1.25rem;
  border: 1px dashed var(--border);
  border-radius: var(--radius);
  font-size: 0.85rem;
  color: var(--text-dim);
  text-align: center;
}
.kpis-group { margin-bottom: 1.5rem; }
.kpis-group-title {
  margin: 0 0 0.6rem;
  font-size: 0.95rem;
  font-weight: 700;
  color: var(--text);
}
/* .kpi-grid's four summary columns are too narrow for a full metric card: one
   column below md, two from md, three on wide screens. */
.kpi-grid.kpis-grid {
  grid-template-columns: minmax(0, 1fr);
  align-items: start;
}
@media (min-width: 768px) {
  .kpi-grid.kpis-grid { grid-template-columns: repeat(2, minmax(0, 1fr)); }
}
@media (min-width: 1600px) {
  .kpi-grid.kpis-grid { grid-template-columns: repeat(3, minmax(0, 1fr)); }
}
.load-error {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 0.75rem;
  margin: 0 0 1rem;
  padding: 0.6rem 0.85rem;
  border-radius: var(--radius);
  background: var(--danger-dim);
  color: #b91c1c;
  font-size: 0.8rem;
}
</style>
