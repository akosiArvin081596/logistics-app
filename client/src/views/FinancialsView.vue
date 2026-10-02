<template>
  <div class="financials-page admin-page">
    <div class="page-header">
      <h2>Financials</h2>
      <div class="page-sub">
        Profit and loss for any range, by period and by truck, driver, load, state or owner. Open months are live;
        closed months are shown exactly as they settled.
      </div>
    </div>

    <FinancialsToolbar
      :selection="selection"
      :export-href="exportHref"
      @update="updateSelection"
      @open-settings="settingsOpen = true"
    />

    <div v-if="selectionErr" class="data-warning" role="alert">
      <div class="data-warning-title">Check the dates</div>
      <div class="data-warning-msg">{{ selectionErr }}</div>
    </div>

    <div v-else-if="store.lastError" class="error-state" role="alert">
      <div class="error-title">Could not load financials</div>
      <div class="error-msg">{{ store.lastError }}</div>
      <button type="button" class="btn btn-primary" @click="store.reload()">Retry</button>
    </div>

    <div v-else-if="!report" class="loading-state" aria-busy="true" aria-label="Loading financials">
      <div class="skeleton skeleton-card" v-for="i in 3" :key="i"></div>
    </div>

    <div v-else class="report" :class="{ stale: store.isLoading }" :aria-busy="store.isLoading ? 'true' : 'false'">
      <div v-if="store.isLoading" class="updating" role="status">
        <span class="spinner" aria-hidden="true"></span> Updating…
      </div>

      <FinancialsKpis :report="report" />

      <section class="section" aria-labelledby="fin-table-title">
        <div class="section-title">
          <div class="section-icon" style="background: var(--blue-dim); color: var(--blue);" aria-hidden="true">
            <Table2 class="icon" />
          </div>
          <h3 id="fin-table-title" class="section-heading">{{ tableTitle }}</h3>
          <span class="section-sub">{{ countedNote }}</span>
        </div>

        <div v-if="isEmpty" class="empty-msg">
          Nothing recorded from {{ fmtYmd(report.from) }} to {{ fmtYmd(report.to) }}. Try a longer range.
        </div>
        <FleetPnlTable v-else-if="report.groupBy === 'fleet'" :report="report" @open-month="openMonth" />
        <GroupReportTable v-else :report="report" />
      </section>
    </div>

    <CostSettingsDialog v-model:open="settingsOpen" @saved="onSettingsSaved" />

    <!-- Month drill-down, from a month's heading in the Fleet P&L -->
    <MonthDetailModal :open="!!selectedMonth" :month="selectedMonth || ''" @close="closeMonth" />
  </div>
</template>

<script setup>
import { computed, ref, watch } from 'vue'
import { useRoute, useRouter } from 'vue-router'
import { Table2 } from 'lucide-vue-next'
import { useFinancialsStore } from '../stores/financials'
import { useSocketRefresh } from '../composables/useSocketRefresh'
import { useToast } from '../composables/useToast'
import { houstonToday, fmtYmd } from '../utils/datetime'
import {
  GRANULARITIES, GROUPINGS,
  readSelection, reportSearch, selectionError, selectionQuery,
} from '../lib/financialsView'
import FinancialsToolbar from '../components/financials/FinancialsToolbar.vue'
import FinancialsKpis from '../components/financials/FinancialsKpis.vue'
import FleetPnlTable from '../components/financials/FleetPnlTable.vue'
import GroupReportTable from '../components/financials/GroupReportTable.vue'
import CostSettingsDialog from '../components/financials/CostSettingsDialog.vue'
import MonthDetailModal from '../components/financials/MonthDetailModal.vue'

// Financials: GET /api/financials/report for the range, granularity and
// grouping in the URL. The server is the source of every figure; this page and
// its components only display them (no sums, differences or ratios here).

const store = useFinancialsStore()
const route = useRoute()
const router = useRouter()
const toast = useToast()

// The selection lives in the URL query so a view can be shared or reloaded.
// Presets ("Last month") are read against the carrier's day, like the server.
const ownRoute = route.name
const selection = computed(() => readSelection(route.query, houstonToday()))
const selectionErr = computed(() => selectionError(selection.value))
const search = computed(() => (selectionErr.value ? '' : reportSearch(selection.value)))
const exportHref = computed(() => (search.value ? `/api/financials/report.csv?${search.value}` : ''))

function updateSelection(patch) {
  const next = { ...selection.value, ...patch }
  router.replace({ query: selectionQuery(next) })
}

watch(search, (s) => {
  // Leaving the page changes the route before this view unmounts.
  if (route.name !== ownRoute || !s) return
  store.request(s)
}, { immediate: true })

const report = computed(() => store.report)
const isEmpty = computed(() => !report.value?.groups?.length)

const tableTitle = computed(() => {
  const r = report.value
  const grouping = GROUPINGS.find((g) => g.key === r?.groupBy)
  const gran = GRANULARITIES.find((g) => g.key === r?.granularity)
  if (!grouping) return ''
  return gran ? `${grouping.title} · by ${gran.label.toLowerCase()}${gran.hint ? ` (${gran.hint})` : ''}` : grouping.title
})

// Which lines the CURRENT settings count; closed months keep their own.
const countedNote = computed(() => {
  const r = report.value
  const lines = r?.lines || []
  const costs = r?.settings?.costs || {}
  const off = lines.filter((l) => costs[l.key] === false).map((l) => l.label)
  const base = off.length ? `Not counted in total costs: ${off.join(', ')}.` : 'Every cost line is counted.'
  return `${base} Closed months keep the settings they closed with.`
})

// Cost settings
const settingsOpen = ref(false)
function onSettingsSaved(result) {
  if (result?.changed) {
    toast.show('Cost settings saved')
    store.reload()
  } else {
    toast.show('No changes to save')
  }
}

// Month drill-down
const selectedMonth = ref(null)
function openMonth(mk) {
  selectedMonth.value = mk
  store.loadMonth(mk)
}
function closeMonth() {
  selectedMonth.value = null
  store.clearMonth()
}

useSocketRefresh('expenses:changed', () => store.reload())
useSocketRefresh('invoices:changed', () => store.reload())
useSocketRefresh('financials:changed', () => store.reload())
</script>

<style scoped>
/* .admin-page (from shared.css) already provides flex column layout,
   and .main applies the horizontal + vertical padding shared by every
   routed page. Only own-specific spacing belongs here. */
.financials-page {
  gap: 1rem;
  padding-bottom: 2rem;
}
.page-header h2 { font-size: 1.4rem; margin: 0; }
.page-sub { font-size: 0.82rem; color: var(--text-dim); margin-top: 0.2rem; max-width: 60rem; }

.loading-state { display: flex; flex-direction: column; gap: 0.75rem; }
.skeleton-card {
  height: 120px;
  background: var(--surface);
  border: 1px solid var(--border);
  border-radius: 12px;
  animation: pulse 1.4s ease-in-out infinite;
}
@keyframes pulse { 0%, 100% { opacity: 0.4; } 50% { opacity: 0.8; } }

.error-state {
  background: var(--danger-dim, #fef2f2);
  border: 1px solid var(--danger-dim, #fecaca);
  border-radius: 10px;
  padding: 1rem 1.25rem;
  color: var(--danger, #b91c1c);
}
.error-title { font-weight: 700; font-size: 0.95rem; }
.error-msg { font-size: 0.8rem; margin: 0.35rem 0 0.75rem; }

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

.report {
  position: relative;
  display: flex;
  flex-direction: column;
  gap: 1rem;
  min-width: 0;
}
.report.stale > :not(.updating) { opacity: 0.55; transition: opacity 0.2s; pointer-events: none; }
.updating {
  position: sticky;
  top: 0.5rem;
  z-index: 5;
  align-self: center;
  display: inline-flex;
  align-items: center;
  gap: 0.45rem;
  padding: 0.35rem 0.85rem;
  font-size: 0.75rem;
  font-weight: 600;
  color: var(--text);
  background: var(--surface);
  border: 1px solid var(--border);
  border-radius: 999px;
  box-shadow: var(--shadow-card);
}
.spinner {
  width: 12px;
  height: 12px;
  border: 2px solid var(--border);
  border-top-color: var(--accent);
  border-radius: 50%;
  animation: spin 0.8s linear infinite;
}
@keyframes spin { to { transform: rotate(360deg); } }

.section {
  background: var(--surface);
  border: 1px solid var(--border);
  border-radius: 12px;
  padding: 1.25rem;
  min-width: 0;
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
}
.section-icon .icon { width: 15px; height: 15px; }
.section-sub {
  margin-left: auto;
  font-size: 0.72rem;
  font-weight: 500;
  color: var(--text-dim);
  max-width: 34rem;
  text-align: right;
}
.empty-msg {
  text-align: center;
  color: var(--text-dim);
  font-size: 0.85rem;
  padding: 1.5rem 0;
}

@media (max-width: 767px) {
  .section { padding: 1rem; }
  .section-sub { margin-left: 0; text-align: left; max-width: none; }
}
@media (prefers-reduced-motion: reduce) {
  .skeleton-card, .spinner { animation: none; }
}
</style>
