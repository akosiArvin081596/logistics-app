<template>
  <div class="analytics-panel">
    <!-- First load: app-style skeleton cards -->
    <template v-if="loading && !data">
      <div class="skeleton skeleton-kpi"></div>
      <div class="skeleton skeleton-card"></div>
      <div class="skeleton skeleton-card"></div>
    </template>

    <!-- Load failure -->
    <div v-else-if="error && !data" class="panel-error" role="alert">
      <span>{{ error }}</span>
      <button type="button" class="retry-btn" @click="load()">Retry</button>
    </div>

    <template v-else-if="data">
      <ExpenseKpiRow :summary="data.summary" />

      <ExpenseFilterBar
        v-model:filters="filters"
        :driver-options="driverOptions"
        :truck-options="truckOptions"
      />

      <!-- Vendor drill-down clear-chip (set via @select-vendor from the vendor cards) -->
      <div v-if="vendorFilter" class="drill-row">
        <button
          type="button"
          class="drill-chip"
          :aria-label="`Clear vendor filter ${vendorFilter}`"
          @click="clearVendor"
        >
          Vendor: {{ vendorFilter }} <span class="drill-x" aria-hidden="true">&#10005;</span>
        </button>
      </div>

      <!-- Data-quality chip -->
      <div v-if="data.summary.unknownVendorCount > 0" class="quality-chip" role="status">
        {{ data.summary.unknownVendorCount }} fuel or repair expense{{ data.summary.unknownVendorCount === 1 ? '' : 's' }}
        {{ data.summary.unknownVendorCount === 1 ? "doesn't" : "don't" }} have a store name yet &mdash; open the expense to add one
      </div>

      <!-- Empty state -->
      <div v-if="data.summary.count === 0" class="empty-msg">
        No expenses match these filters. Widen the date range or clear a filter to see data.
      </div>

      <div v-else class="analytics-results" :class="{ 'is-refreshing': loading }">
        <!-- AI row: query panel + insights. Either emitting 'unavailable' (503)
             hides the whole row for the session. -->
        <div v-if="aiAvailable" class="ai-row">
          <AiQueryPanel @unavailable="aiAvailable = false" />
          <InsightsCard :active="true" @unavailable="aiAvailable = false" />
        </div>

        <div class="cards-grid">
          <TopVendorsCard :vendors="data.byVendor" @select-vendor="drillVendor" />
          <StateBreakdownCard
            :states="data.byState"
            :no-state-count="data.summary.noStateCount"
            :no-state-spend="data.summary.noStateSpend"
          />
          <MonthlyTrendCard :months="data.byMonth" />
          <TypeBreakdownCard :types="data.byType" />
        </div>

        <ExpenseMap :locations="data.locations" :visible="true" />

        <VendorLeaderboardTable :vendors="data.byVendor" @select-vendor="drillVendor" />
      </div>
    </template>
  </div>
</template>

<script setup>
import { ref, watch, onMounted } from 'vue'
import { useApi } from '../../../composables/useApi'
import ExpenseFilterBar from './ExpenseFilterBar.vue'
import AiQueryPanel from './AiQueryPanel.vue'
import { ANALYTICS_FIXTURE } from './fixtures'
import ExpenseKpiRow from './ExpenseKpiRow.vue'
import InsightsCard from './InsightsCard.vue'
import TopVendorsCard from './TopVendorsCard.vue'
import StateBreakdownCard from './StateBreakdownCard.vue'
import MonthlyTrendCard from './MonthlyTrendCard.vue'
import TypeBreakdownCard from './TypeBreakdownCard.vue'
import ExpenseMap from './ExpenseMap.vue'
import VendorLeaderboardTable from './VendorLeaderboardTable.vue'

// Dev-fixtures switch: when true, load() serves ANALYTICS_FIXTURE instead of
// hitting GET /api/expenses/analytics (kept for future offline UI work).
const USE_FIXTURES = false

const props = defineProps({
  // Passed down from ExpensesTab (which already loads both lists) to avoid a
  // second /api/drivers-directory + /api/trucks fetch.
  driverOptions: { type: Array, default: () => [] },
  truckOptions: { type: Array, default: () => [] },
})

const api = useApi()

// One object, the exact shape ExpenseFilterBar emits via update:filters.
const filters = ref({
  from: '',
  to: '',
  region: '',
  states: [],
  types: [],
  q: '',
  driver: '',
  truck: '',
})
const data = ref(null)
const loading = ref(true)
const error = ref('')
const aiAvailable = ref(true)
// Vendor drill-down (set by TopVendorsCard / VendorLeaderboardTable row clicks;
// sent as ?vendor= to the analytics endpoint).
const vendorFilter = ref('')

// Monotonic sequence guards against out-of-order responses when filters
// change faster than requests resolve — only the latest request may commit.
let reqSeq = 0

async function load({ quiet = false } = {}) {
  const seq = ++reqSeq
  if (!quiet) loading.value = true
  error.value = ''
  try {
    let next
    if (USE_FIXTURES) {
      await new Promise((resolve) => setTimeout(resolve, 300))
      // Deep clone (pure JSON) so downstream mutation never corrupts the fixture.
      next = JSON.parse(JSON.stringify(ANALYTICS_FIXTURE))
    } else {
      const params = new URLSearchParams()
      const f = filters.value
      if (f.from) params.set('from', f.from)
      if (f.to) params.set('to', f.to)
      if (f.types?.length) params.set('types', f.types.join(','))
      if (f.states?.length) params.set('states', f.states.join(','))
      if (f.region) params.set('region', f.region)
      if (f.driver) params.set('driver', f.driver)
      if (f.truck) params.set('truck', f.truck)
      if (f.q && f.q.trim()) params.set('q', f.q.trim())
      if (vendorFilter.value) params.set('vendor', vendorFilter.value)
      const qs = params.toString()
      next = await api.get(`/api/expenses/analytics${qs ? `?${qs}` : ''}`)
    }
    if (seq !== reqSeq) return // stale — a newer request is in flight
    data.value = next
  } catch (err) {
    if (seq !== reqSeq) return
    error.value = err?.message || 'Failed to load expense analytics'
  } finally {
    if (seq === reqSeq) loading.value = false
  }
}

// Exposed for ExpensesTab's expenses:changed socket handler — refresh without
// the skeleton flash (mirrors the tab's quietReload pattern).
function reload() {
  return load({ quiet: true })
}
defineExpose({ reload })

// Any filter change refetches. The bar debounces text input itself, so this
// fires at most once per settled change.
watch(filters, () => load(), { deep: true })
watch(vendorFilter, () => load())

function drillVendor(v) {
  // Accept either a vendor name string or a byVendor row object.
  const name = typeof v === 'string' ? v : (v && v.vendor) || ''
  if (!name || name === vendorFilter.value) return
  vendorFilter.value = name
}

function clearVendor() {
  vendorFilter.value = ''
}

onMounted(() => load())
</script>

<style scoped>
.analytics-panel {
  display: flex;
  flex-direction: column;
  gap: 0.75rem;
}

.analytics-results {
  display: flex;
  flex-direction: column;
  gap: 0.75rem;
  transition: opacity 0.15s;
}

/* Refetch in progress (filters changed): dim the stale content instead of a
   skeleton flash. */
.is-refreshing {
  opacity: 0.55;
  pointer-events: none;
}

/* Desktop grid → mobile single column */
.ai-row {
  display: grid;
  grid-template-columns: repeat(auto-fit, minmax(320px, 1fr));
  gap: 0.75rem;
}

.cards-grid {
  display: grid;
  grid-template-columns: repeat(2, minmax(0, 1fr));
  gap: 0.75rem;
}

/* Empty until Peter's cards land — collapse rather than reserving space. */
.cards-grid:empty { display: none; }

@media (max-width: 767px) {
  .ai-row,
  .cards-grid {
    grid-template-columns: 1fr;
  }
}

/* Vendor drill-down clear-chip */
.drill-row { display: flex; }

.drill-chip {
  display: inline-flex;
  align-items: center;
  gap: 0.45rem;
  padding: 0.3rem 0.7rem;
  background: var(--accent-dim);
  border: 1px solid var(--accent);
  border-radius: 999px;
  font-family: inherit;
  font-size: 0.74rem;
  font-weight: 600;
  color: var(--accent);
  cursor: pointer;
  transition: opacity 0.15s;
}

.drill-chip:hover { opacity: 0.8; }

.drill-x { font-size: 0.68rem; }

/* Data-quality chip */
.quality-chip {
  align-self: flex-start;
  padding: 0.32rem 0.7rem;
  background: var(--amber-dim);
  border: 1px solid var(--amber);
  border-radius: 999px;
  font-size: 0.72rem;
  font-weight: 600;
  color: var(--amber);
}

/* Error + retry */
.panel-error {
  display: flex;
  align-items: center;
  justify-content: center;
  gap: 0.75rem;
  flex-wrap: wrap;
  padding: 1.5rem 1rem;
  border: 1px solid var(--danger-dim);
  border-radius: var(--radius);
  background: var(--danger-dim);
  color: var(--danger);
  font-size: 0.82rem;
}

.retry-btn {
  padding: 0.35rem 0.85rem;
  border: none;
  border-radius: 6px;
  background: var(--danger);
  color: #fff;
  font-family: inherit;
  font-size: 0.76rem;
  font-weight: 600;
  cursor: pointer;
  transition: opacity 0.15s;
}

.retry-btn:hover { opacity: 0.85; }

/* Empty state — mirrors ExpensesTab's .empty-msg (scoped there, so re-declared) */
.empty-msg {
  text-align: center;
  color: var(--text-dim);
  font-size: 0.85rem;
  padding: 2rem 1rem;
}

/* Skeletons — shimmer pattern shared across the app (scoped per component) */
.skeleton {
  background: linear-gradient(90deg, var(--bg) 25%, var(--surface-hover) 50%, var(--bg) 75%);
  background-size: 200% 100%;
  animation: shimmer 1.5s infinite;
  border-radius: var(--radius);
}

.skeleton-kpi { height: 72px; }
.skeleton-card { height: 180px; }

@keyframes shimmer {
  0% { background-position: 200% 0; }
  100% { background-position: -200% 0; }
}
</style>
