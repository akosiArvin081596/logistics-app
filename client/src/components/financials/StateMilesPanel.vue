<template>
  <section class="section" aria-labelledby="fin-state-miles-title">
    <div class="section-title">
      <div class="section-icon" style="background: var(--blue-dim); color: var(--blue);" aria-hidden="true">
        <MapPinned class="icon" />
      </div>
      <h3 id="fin-state-miles-title" class="section-heading">Miles driven by state (ELD)</h3>
      <span class="section-sub">{{ note }}</span>
    </div>

    <div v-if="error" class="error-msg" role="alert">{{ error }}</div>
    <div v-else-if="!data" class="loading-msg" aria-busy="true">Loading miles by state…</div>
    <div v-else-if="!data.states.length" class="empty-msg">No ELD miles recorded in this range.</div>
    <div v-else class="table-wrap">
      <table class="miles-table">
        <thead>
          <tr>
            <th scope="col">State</th>
            <th scope="col" class="num">Miles</th>
            <th scope="col" class="num">Share</th>
            <th v-for="p in data.periods" :key="p.key" scope="col" class="num">{{ p.label }}</th>
          </tr>
        </thead>
        <tbody>
          <template v-for="s in data.states" :key="s.state">
            <tr class="state-row" @click="toggle(s.state)">
              <th scope="row">
                <button type="button" class="expand" :aria-expanded="open.has(s.state) ? 'true' : 'false'">
                  {{ open.has(s.state) ? '▾' : '▸' }} {{ s.state }}
                </button>
              </th>
              <td class="num">{{ formatCount(s.total) }}</td>
              <td class="num">{{ s.share === 0 && s.total > 0 ? '<0.1%' : formatPct(s.share) }}</td>
              <td v-for="p in data.periods" :key="p.key" class="num">{{ s.byPeriod[p.key] ? formatCount(s.byPeriod[p.key]) : '—' }}</td>
            </tr>
            <tr v-for="t in trucksOf(s)" v-show="open.has(s.state)" :key="s.state + ':' + t.unit" class="truck-row">
              <th scope="row" class="truck">{{ t.unit }}</th>
              <td class="num">{{ formatCount(t.miles) }}</td>
              <td :colspan="1 + data.periods.length"></td>
            </tr>
          </template>
        </tbody>
        <tfoot>
          <tr>
            <th scope="row">Total</th>
            <td class="num">{{ formatCount(data.total) }}</td>
            <td :colspan="1 + data.periods.length"></td>
          </tr>
        </tfoot>
      </table>
    </div>
  </section>
</template>

<script setup>
import { computed, ref, watch } from 'vue'
import { MapPinned } from 'lucide-vue-next'
import { useApi } from '../../composables/useApi'
import { fmtYmd } from '../../utils/datetime'
import { formatCount, formatPct } from '../../lib/financialsView'

// Miles driven in each state, as the ELD measured them (GET /api/financials/
// state-miles), for the report's range and periods. Every figure is the
// server's; this only lays them out.
const props = defineProps({
  from: { type: String, required: true },
  to: { type: String, required: true },
  granularity: { type: String, required: true },
})

const api = useApi()
const data = ref(null)
const error = ref('')
const open = ref(new Set())
let reqId = 0

async function load() {
  const id = ++reqId
  error.value = ''
  data.value = null
  try {
    const q = new URLSearchParams({ from: props.from, to: props.to, granularity: props.granularity })
    const res = await api.get(`/api/financials/state-miles?${q}`)
    if (id === reqId) data.value = res
  } catch (err) {
    if (id === reqId) error.value = err?.message || 'Failed to load miles by state'
  }
}
watch(() => [props.from, props.to, props.granularity], load, { immediate: true })

function toggle(state) {
  const next = new Set(open.value)
  if (next.has(state)) next.delete(state)
  else next.add(state)
  open.value = next
}
const trucksOf = (s) => Object.entries(s.byTruck || {})
  .map(([unit, miles]) => ({ unit, miles }))
  .sort((a, b) => b.miles - a.miles)

const note = computed(() => {
  if (!data.value || !data.value.recordedFrom) return 'ELD-linked trucks only'
  return `ELD-linked trucks only · recorded from ${fmtYmd(data.value.recordedFrom)}`
})
</script>

<style scoped>
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
}
@media (max-width: 767px) {
  .section-sub { margin-left: 0; width: 100%; }
}
.table-wrap { overflow-x: auto; }
.miles-table { width: 100%; border-collapse: collapse; font-size: 0.85rem; }
.miles-table th, .miles-table td { padding: 0.45rem 0.6rem; border-bottom: 1px solid var(--border); text-align: left; white-space: nowrap; }
.miles-table thead th { font-size: 0.72rem; text-transform: uppercase; letter-spacing: 0.04em; color: var(--text-dim); }
.miles-table .num { text-align: right; font-variant-numeric: tabular-nums; }
.miles-table tfoot th, .miles-table tfoot td { font-weight: 700; border-top: 2px solid var(--border); }
.state-row { cursor: pointer; }
.expand { background: none; border: 0; padding: 0; font: inherit; color: inherit; cursor: pointer; }
.truck-row .truck { padding-left: 1.6rem; font-weight: 400; color: var(--text-dim); }
.error-msg, .loading-msg, .empty-msg { padding: 1rem; color: var(--text-dim); }
.error-msg { color: var(--red, #dc2626); }
</style>
