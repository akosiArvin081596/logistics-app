<template>
  <div class="analytics-page admin-page">
    <div class="page-header">
      <h2>Mileage Analytics</h2>
      <div class="page-sub">
        Miles actually driven, from the ELD odometer — per truck, per driver, by week and month.
      </div>
    </div>

    <div v-if="loading && !data" class="loading-state">
      <div class="skeleton skeleton-card" v-for="i in 5" :key="i"></div>
    </div>

    <div v-else-if="error" class="error-state">
      <div class="error-title">Could not load mileage</div>
      <div class="error-msg">{{ error }}</div>
      <button class="btn btn-primary" @click="load()">Retry</button>
    </div>

    <template v-else-if="data">
      <!-- ⚠️ THE COVERAGE NOTICE IS NOT DECORATION. Only some trucks report, so a
           reader who takes the fleet figures as complete will be wrong by a large
           factor. The denominator is stated rather than implied. -->
      <div v-if="coverageGap" class="data-warning">
        <div class="data-warning-title">&#9888; These figures cover part of the fleet</div>
        <div class="data-warning-msg">
          Mileage is measured from the ELD.
          <strong>{{ data.coverage.trucksEldLinked }}</strong> of
          <strong>{{ data.coverage.trucksInService }}</strong> trucks have one linked, and this
          window observed <strong>{{ data.company.truckWeeksCovered }}</strong> of
          <strong>{{ data.company.truckWeeksTotal }}</strong> truck-weeks.
          A truck we cannot see reads <strong>&mdash;</strong>, not zero.
          <template v-if="data.coverage.trucksNoEld.length">
            No device linked:
            <strong>{{ data.coverage.trucksNoEld.map(t => t.unitNumber).join(', ') }}</strong>.
          </template>
          <template v-if="darkTrucks.length">
            Not reporting:
            <strong>{{ darkTrucks.map(t => `${t.unitNumber} (${t.daysDark}d)`).join(', ') }}</strong>.
          </template>
        </div>
      </div>

      <!-- An ELD reporting miles that belong to no truck. Its distance is in
           nobody's totals, so it is surfaced with the figure attached rather
           than guessed onto a truck. -->
      <div v-if="data.coverage.unlinkedVehicles.length" class="data-warning idle-warning">
        <div class="data-warning-title">&#128679; Unlinked ELD reporting miles</div>
        <div class="data-warning-msg">
          <span v-for="v in data.coverage.unlinkedVehicles" :key="v.routemateVehicleId">
            Device <strong>{{ v.routemateVehicleId }}</strong> logged
            <strong>{{ fmtMi(v.milesInRange) }}</strong> in this window but is not linked to any
            truck, so those miles are in nobody's totals. Link it in Truck Database to include them.
          </span>
        </div>
      </div>

      <!-- Company summary -->
      <section class="section">
        <div class="section-title">
          <div class="section-icon" style="background: var(--accent-dim); color: var(--accent);">&#8721;</div>
          Company
          <span class="section-sub">{{ data.from }} &rarr; {{ data.to }} &middot; Sat&ndash;Fri weeks</span>
        </div>
        <div class="kpi-grid">
          <div class="kpi-card">
            <div class="kpi-label">Average per week</div>
            <div class="kpi-value">{{ fmtMi(data.company.weeklyAverageMiles) }}</div>
            <div class="kpi-sub">whole fleet, per week</div>
          </div>
          <div class="kpi-card">
            <div class="kpi-label">Average per truck / week</div>
            <div class="kpi-value">{{ fmtMi(data.company.weeklyAveragePerTruck) }}</div>
            <div class="kpi-sub">over {{ data.company.truckWeeksCovered }} observed truck-weeks</div>
          </div>
          <div class="kpi-card">
            <div class="kpi-label">Total miles</div>
            <div class="kpi-value">{{ fmtMi(data.company.totalMiles) }}</div>
            <div class="kpi-sub">since {{ data.coverageStartDay || '—' }}</div>
          </div>
          <div class="kpi-card">
            <div class="kpi-label">Coverage</div>
            <div class="kpi-value">
              <span class="basis-badge" :class="'b-' + basisInfo(data.company.basis).cls"
                    :title="basisInfo(data.company.basis).title">{{ basisInfo(data.company.basis).label }}</span>
            </div>
            <div class="kpi-sub">{{ data.company.truckWeeksCovered }} / {{ data.company.truckWeeksTotal }} truck-weeks</div>
          </div>
        </div>
      </section>

      <!-- Grain toggle -->
      <div class="grain-row">
        <button
          v-for="g in GRAINS" :key="g.key"
          class="grain-btn" :class="{ active: grain === g.key }"
          @click="grain = g.key"
        >{{ g.label }}</button>
      </div>

      <!-- Per truck -->
      <section class="section">
        <div class="section-title">
          <div class="section-icon" style="background: var(--accent-dim); color: var(--accent);">&#128667;</div>
          By truck
        </div>
        <div class="table-scroll">
          <table class="data-table mileage-table">
            <thead>
              <tr>
                <th class="sticky-col">Truck</th>
                <th v-for="p in periods" :key="p.key" class="num">{{ p.label }}</th>
                <th class="num total-col">Total</th>
              </tr>
            </thead>
            <tbody>
              <tr v-for="r in truckRows" :key="r.name">
                <td class="sticky-col">
                  <div class="row-name">{{ r.name }}</div>
                  <div v-if="r.sub" class="row-sub">{{ r.sub }}</div>
                </td>
                <td v-for="p in periods" :key="p.key" class="num" :class="{ muted: cellMiles(r, p) == null }">
                  {{ fmtMi(cellMiles(r, p)) }}<span v-if="cellPartial(r, p)" class="cell-flag" :title="BASIS.partial.title">*</span>
                </td>
                <td class="num total-col">
                  {{ fmtMi(r.total && r.total.miles) }}
                  <span class="basis-badge" :class="'b-' + basisOf(r).cls" :title="basisOf(r).title">{{ basisOf(r).label }}</span>
                </td>
              </tr>
            </tbody>
          </table>
        </div>
      </section>

      <!-- Per driver -->
      <section class="section">
        <div class="section-title">
          <div class="section-icon" style="background: var(--accent-dim); color: var(--accent);">&#128100;</div>
          By driver
        </div>
        <div class="table-scroll">
          <table class="data-table mileage-table">
            <thead>
              <tr>
                <th class="sticky-col">Driver</th>
                <th v-for="p in periods" :key="p.key" class="num">{{ p.label }}</th>
                <th class="num total-col">Total</th>
              </tr>
            </thead>
            <tbody>
              <tr v-for="r in driverRows" :key="r.name">
                <td class="sticky-col">
                  <div class="row-name">{{ r.name }}</div>
                  <div v-if="r.sub" class="row-sub">{{ r.sub }}</div>
                </td>
                <td v-for="p in periods" :key="p.key" class="num" :class="{ muted: cellMiles(r, p) == null }">
                  {{ fmtMi(cellMiles(r, p)) }}<span v-if="cellPartial(r, p)" class="cell-flag" :title="BASIS.partial.title">*</span>
                </td>
                <td class="num total-col">
                  {{ fmtMi(r.total && r.total.miles) }}
                  <span class="basis-badge" :class="'b-' + basisOf(r).cls" :title="basisOf(r).title">{{ basisOf(r).label }}</span>
                </td>
              </tr>
            </tbody>
          </table>
        </div>
      </section>

      <p class="analytics-note" v-for="n in data.notes" :key="n">{{ n }}</p>
    </template>
  </div>
</template>

<script setup>
import { ref, computed, onMounted } from 'vue'
import { useApi } from '../composables/useApi'

const api = useApi()
const data = ref(null)
const loading = ref(false)
const error = ref('')
const grain = ref('week')

const GRAINS = [
  { key: 'week', label: 'By week' },
  { key: 'month', label: 'By month' },
]

// A truck is worth calling out as dark once it has missed more than a day —
// below that it is just a quiet night, not a fault.
const darkTrucks = computed(() =>
  (data.value?.coverage?.trucksDark || []).filter((t) => t.daysDark == null || t.daysDark >= 2)
)

const coverageGap = computed(() => {
  const d = data.value
  if (!d) return false
  return d.coverage.trucksEldLinked < d.coverage.trucksInService
    || d.company.truckWeeksCovered < d.company.truckWeeksTotal
})

// The period columns for the selected grain, taken from the company block so
// every table shows the same columns even where a row has no data for one.
const periods = computed(() => {
  const d = data.value
  if (!d) return []
  if (grain.value === 'week') {
    return d.company.weeks.map((w) => ({ key: w.weekStart, label: shortWeek(w.weekStart, w.weekEnd) }))
  }
  const months = new Set()
  for (const t of d.trucks) for (const mo of t.months || []) months.add(mo.month)
  return [...months].sort().map((k) => ({ key: k, label: k }))
})

function seriesFor(row) {
  const list = grain.value === 'week' ? (row.weeks || []) : (row.months || [])
  const byKey = new Map()
  for (const p of list) byKey.set(grain.value === 'week' ? p.weekStart : p.month, p)
  return byKey
}

const truckRows = computed(() =>
  (data.value?.trucks || []).map((t) => ({
    name: t.unitNumber, sub: t.eldLinked ? '' : 'no ELD linked',
    total: t.total, series: seriesFor(t),
  })).sort(sortByTotalDesc)
)
const driverRows = computed(() =>
  (data.value?.drivers || []).map((d) => ({
    name: d.driver, sub: (d.truckUnits || []).join(', '),
    total: d.total, series: seriesFor(d),
  })).sort(sortByTotalDesc)
)
// Rows we cannot measure sort last rather than sorting as zero — they are not
// the worst performers, they are the unmeasured ones.
function sortByTotalDesc(a, b) {
  const av = a.total?.miles, bv = b.total?.miles
  if (av == null && bv == null) return 0
  if (av == null) return 1
  if (bv == null) return -1
  return bv - av
}

function shortWeek(start, end) {
  const s = String(start).slice(5).replace('-', '/')
  const e = String(end).slice(5).replace('-', '/')
  return `${s}–${e}`
}
// ⚠️ null renders as an em dash, NEVER as 0. "0 miles" claims the truck did not
// move; the truth is that we cannot see it.
function fmtMi(v) {
  if (v == null) return '—'
  return Number(v).toLocaleString('en-US')
}

// ⚠️ THESE ARE PLAIN HELPERS AND THE TABLE IS PLAIN TEMPLATE MARKUP, NOT A
// FUNCTIONAL COMPONENT BUILT WITH h(). Vue's scoped CSS works by stamping a
// data attribute onto elements the TEMPLATE COMPILER emits; vnodes created by
// h() inside <script setup> never receive it, so every scoped rule here silently
// did nothing — the numbers rendered left-aligned with no column widths and the
// header row ran together. Keep this in the template.
const BASIS = {
  eld: { label: 'ELD', cls: 'ok', title: 'Every day in this period was fully observed by the ELD.' },
  partial: { label: 'partly', cls: 'warn', title: 'Some of this period was not observed — the ELD was dark, or a reading was rejected. The real figure is higher.' },
  'no-data': { label: 'no data', cls: 'none', title: 'No ELD coverage at all for this period. This is not zero miles — it is an unknown.' },
}
function basisInfo(b) { return BASIS[b] || BASIS['no-data'] }
function basisOf(row) { return basisInfo(row.total && row.total.basis) }
function cellMiles(row, p) {
  const c = row.series.get(p.key)
  return c ? c.miles : null
}
function cellPartial(row, p) {
  const c = row.series.get(p.key)
  return !!c && c.basis === 'partial'
}

async function load() {
  loading.value = true
  error.value = ''
  try {
    data.value = await api.get('/api/analytics/mileage')
  } catch (e) {
    error.value = e.message || 'Request failed'
  } finally {
    loading.value = false
  }
}
onMounted(load)
</script>

<style scoped>
/* ⚠️ .section / .section-title / .section-icon are NOT global — they are scoped
   inside FinancialsView.vue. Only .kpi-card and .data-warning live in
   assets/shared.css. Without these the icon renders as a full-width bar with the
   heading orphaned underneath, which is exactly what happened first time. Values
   copied from FinancialsView so the two pages read as one product. */
.section {
  background: var(--surface, #fff);
  border: 1px solid var(--border, #d8dbe3);
  border-radius: 12px;
  padding: 1.25rem;
  margin-bottom: 1rem;
}
.section-title {
  display: flex;
  align-items: center;
  gap: 0.6rem;
  font-weight: 700;
  font-size: 0.95rem;
  margin-bottom: 1rem;
}
.section-icon {
  width: 28px; height: 28px; border-radius: 8px;
  display: flex; align-items: center; justify-content: center;
  font-size: 0.85rem; font-weight: 700;
  flex: none;
}
.section-sub {
  margin-left: auto;
  font-size: 0.72rem;
  font-weight: 500;
  color: var(--text-dim, #6b7085);
}
.kpi-grid {
  display: grid;
  grid-template-columns: repeat(auto-fit, minmax(180px, 1fr));
  gap: 0.75rem;
}

.grain-row { display: flex; gap: 0.4rem; margin: 0 0 0.75rem; }
.grain-btn {
  padding: 0.35rem 0.8rem;
  border: 1px solid var(--border, #d8dbe3);
  background: var(--surface, #fff);
  border-radius: 999px;
  font-size: 0.82rem;
  font-weight: 600;
  color: var(--text-dim, #6b7085);
  cursor: pointer;
}
.grain-btn.active { background: var(--accent, #2563eb); border-color: var(--accent, #2563eb); color: #fff; }

/* Wide period tables must scroll INSIDE their own container — the page body
   must never scroll horizontally. */
.table-scroll { overflow-x: auto; -webkit-overflow-scrolling: touch; }
.mileage-table { width: 100%; border-collapse: collapse; font-size: 0.86rem; }
.mileage-table th, .mileage-table td { padding: 0.45rem 0.85rem; white-space: nowrap; }
.mileage-table thead th.num, .mileage-table td.num { min-width: 92px; }
.mileage-table .sticky-col { min-width: 150px; }
.mileage-table thead th { font-size: 0.72rem; text-transform: uppercase; letter-spacing: 0.03em; color: var(--text-dim, #6b7085); border-bottom: 1px solid var(--border, #d8dbe3); }
.mileage-table tbody tr { border-bottom: 1px solid var(--border-soft, #eef0f4); }
.mileage-table .num { text-align: right; font-variant-numeric: tabular-nums; }
.mileage-table .num.muted { color: var(--text-dim, #9aa0ae); }
.mileage-table .total-col { font-weight: 700; }
.sticky-col { position: sticky; left: 0; background: var(--surface, #fff); text-align: left; z-index: 1; }
.row-name { font-weight: 600; }
.row-sub { font-size: 0.72rem; color: var(--text-dim, #6b7085); }
.cell-flag { color: #b45309; margin-left: 0.15rem; font-weight: 700; }

.basis-badge { display: inline-block; padding: 0.05rem 0.4rem; border-radius: 999px; font-size: 0.66rem; font-weight: 700; text-transform: uppercase; letter-spacing: 0.02em; }
.b-ok { background: #dcfce7; color: #166534; }
.b-warn { background: #fef3c7; color: #92400e; }
.b-none { background: #e5e7eb; color: #4b5563; }

.analytics-note { font-size: 0.76rem; color: var(--text-dim, #6b7085); margin: 0.3rem 0 0; line-height: 1.5; }

@media (max-width: 768px) {
  .mileage-table { font-size: 0.78rem; }
  .mileage-table th, .mileage-table td { padding: 0.35rem 0.45rem; }
}
</style>
