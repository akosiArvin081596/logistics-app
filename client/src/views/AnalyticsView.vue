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

      <!-- KPIs. Each opens an explanation — the client asked to understand why
           these numbers are shown, so every headline can say what it is. -->
      <section class="section">
        <div class="section-title">
          <div class="section-icon" style="background: var(--accent-dim); color: var(--accent);">&#8721;</div>
          Company
          <span class="section-sub">{{ data.from }} &rarr; {{ data.to }} &middot; Sat&ndash;Fri weeks</span>
        </div>
        <div class="kpi-grid">
          <div
            v-for="k in kpis" :key="k.key"
            class="kpi-card clickable" role="button" tabindex="0"
            :aria-label="`Explain ${k.label}`"
            @click="explain = k.key"
            @keyup.enter="explain = k.key" @keyup.space.prevent="explain = k.key"
          >
            <div class="kpi-label">{{ k.label }}</div>
            <div class="kpi-value">
              <span v-if="k.badge" class="basis-badge" :class="'b-' + basisInfo(k.badge).cls">{{ basisInfo(k.badge).label }}</span>
              <template v-else>{{ k.value }}</template>
            </div>
            <div class="kpi-sub">{{ k.sub }}</div>
            <div class="click-hint">Click to see what this means</div>
          </div>
        </div>
      </section>

      <!-- Weekly trend. Clicking a bar selects that week, which highlights its
           column in both tables below — the way into the per-truck detail. -->
      <section class="section">
        <MileageTrendChart :weeks="data.company.weeks" @select="onWeekSelect">
          <template #title>Fleet by week</template>
        </MileageTrendChart>
        <div v-if="selectedWeek" class="week-pin">
          Week of <strong>{{ selectedWeek }}</strong> highlighted below.
          <button class="linkish" @click="selectedWeek = ''">clear</button>
        </div>
        <p v-if="data.fuelCoverage && data.fuelCoverage.note" class="analytics-note">
          {{ data.fuelCoverage.note }}
        </p>
      </section>

      <div class="grain-row">
        <button
          v-for="g in GRAINS" :key="g.key"
          class="grain-btn" :class="{ active: grain === g.key }"
          @click="grain = g.key"
        >{{ g.label }}</button>
      </div>

      <section class="section">
        <div class="section-title">
          <div class="section-icon" style="background: var(--accent-dim); color: var(--accent);">&#128667;</div>
          By truck
          <span class="section-sub">Click any figure to see the days behind it</span>
        </div>
        <MileageTable
          :rows="truckRows" :periods="periods" label="Truck"
          :selected-period="selectedWeek"
          @drill="onDrill"
        />
      </section>

      <section class="section">
        <div class="section-title">
          <div class="section-icon" style="background: var(--accent-dim); color: var(--accent);">&#128100;</div>
          By driver
          <span class="section-sub">Click any figure to see the days behind it</span>
        </div>
        <MileageTable
          :rows="driverRows" :periods="periods" label="Driver"
          :selected-period="selectedWeek"
          @drill="onDrill"
        />
      </section>

      <p class="analytics-note" v-for="n in data.notes" :key="n">{{ n }}</p>
    </template>

    <MileageDetailModal
      :open="drillOpen"
      :title="drillTitle"
      :subtitle="drillSubtitle"
      :detail="drillDetail"
      :loading="drillLoading"
      :error="drillError"
      @close="drillOpen = false"
    />

    <MetricInfoDialog
      :open="!!explain"
      :title="explainCopy.title"
      :subtitle="explainCopy.subtitle"
      @update:open="(v) => { if (!v) explain = '' }"
    >
      <div class="modal-explain" v-html="explainCopy.body"></div>
    </MetricInfoDialog>
  </div>
</template>

<script setup>
import { ref, computed, onMounted } from 'vue'
import { useApi } from '../composables/useApi'
import MileageTrendChart from '../components/analytics/MileageTrendChart.vue'
import MileageDetailModal from '../components/analytics/MileageDetailModal.vue'
import MileageTable from '../components/analytics/MileageTable.vue'
import MetricInfoDialog from '../components/investor/MetricInfoDialog.vue'

const api = useApi()
const data = ref(null)
const loading = ref(false)
const error = ref('')
const grain = ref('week')
const selectedWeek = ref('')
const explain = ref('')

const GRAINS = [
  { key: 'week', label: 'By week' },
  { key: 'month', label: 'By month' },
]

const darkTrucks = computed(() =>
  (data.value?.coverage?.trucksDark || []).filter((t) => t.daysDark == null || t.daysDark >= 2)
)
const coverageGap = computed(() => {
  const d = data.value
  if (!d) return false
  return d.coverage.trucksEldLinked < d.coverage.trucksInService
    || d.company.truckWeeksCovered < d.company.truckWeeksTotal
})

const kpis = computed(() => {
  const c = data.value?.company
  if (!c) return []
  return [
    { key: 'weekly', label: 'Average per week', value: fmtMi(c.weeklyAverageMiles), sub: 'whole fleet, per week' },
    { key: 'perTruck', label: 'Average per truck / week', value: fmtMi(c.weeklyAveragePerTruck), sub: `over ${c.truckWeeksCovered} observed truck-weeks` },
    { key: 'total', label: 'Total miles', value: fmtMi(c.totalMiles), sub: `since ${data.value.coverageStartDay || '—'}` },
    { key: 'coverage', label: 'Coverage', badge: c.basis, sub: `${c.truckWeeksCovered} / ${c.truckWeeksTotal} truck-weeks` },
  ]
})

// Why each number is what it is. The client asked for exactly this.
const EXPLAIN = {
  weekly: {
    title: 'Average per week',
    subtitle: 'Whole-fleet miles, averaged over the weeks in view',
    body: `Every mile the fleet drove in this range, divided by the number of Saturday–Friday weeks in it.
      <br><br>This is the <strong>fleet total</strong> per week — not per truck. It answers "how much driving does this company do in a week".
      <br><br>Weeks run Saturday to Friday because that is the week driver invoices are paid on, so mileage and pay line up on the same days.`,
  },
  perTruck: {
    title: 'Average per truck / week',
    subtitle: 'Restricted to truck-weeks we actually observed',
    body: `Fleet miles divided by the number of <strong>truck-weeks we could see</strong> — not by the number of trucks you own.
      <br><br>That distinction matters. A truck with no ELD, or one whose device is dark, contributes nothing to the miles. If it still counted in the denominator, this average would be dragged down by trucks we simply cannot measure, and would understate how hard the working trucks are running.
      <br><br>The count beneath the figure tells you how much of the fleet it covers.`,
  },
  total: {
    title: 'Total miles',
    subtitle: 'Odometer distance, not route distance',
    body: `The sum of actual odometer movement, from the trucks' own ELDs.
      <br><br>This is <strong>not</strong> the same as the "Total Miles" on the Financials page. That figure is the <em>quoted</em> length of booked routes, so it misses deadhead, detours and repositioning. This one is what the odometer turned.
      <br><br>It starts from when ELD coverage began, not from the founding of the company — raw tracking data is kept for 90 days, so the history reaches back only as far as the rollup does.`,
  },
  coverage: {
    title: 'Coverage',
    subtitle: 'How much of the fleet these figures can see',
    body: `<strong>ELD</strong> means every day in view was fully observed.<br>
      <strong>Partly</strong> means some of it was not — a device was dark, or a reading was rejected. The real figure is <em>higher</em> than shown.<br>
      <strong>No data</strong> means no coverage at all. That is not zero miles; it is an unknown, and it renders as a dash.
      <br><br>A truck we cannot see is never reported as zero. Zero is a claim that it did not move; a dash is the truth, which is that we do not know.`,
  },
}
const explainCopy = computed(() => EXPLAIN[explain.value] || { title: '', subtitle: '', body: '' })

const periods = computed(() => {
  const d = data.value
  if (!d) return []
  if (grain.value === 'week') {
    return d.company.weeks.map((w) => ({ key: w.weekStart, label: shortWeek(w.weekStart, w.weekEnd), end: w.weekEnd }))
  }
  const months = new Set()
  for (const t of d.trucks) for (const mo of t.months || []) months.add(mo.month)
  return [...months].sort().map((k) => ({ key: k, label: k, end: '' }))
})

function seriesFor(row) {
  const list = grain.value === 'week' ? (row.weeks || []) : (row.months || [])
  const byKey = new Map()
  for (const p of list) byKey.set(grain.value === 'week' ? p.weekStart : p.month, p)
  return byKey
}

const truckRows = computed(() =>
  (data.value?.trucks || []).map((t) => ({
    id: 'truck:' + t.truckId, name: t.unitNumber, sub: t.eldLinked ? '' : 'no ELD linked',
    vehicleId: t.routemateVehicleId, driverKey: '',
    total: t.total, series: seriesFor(t),
  })).sort(sortByTotalDesc)
)
const driverRows = computed(() =>
  (data.value?.drivers || []).map((d) => ({
    id: 'driver:' + d.driverKey, name: d.driver, sub: (d.truckUnits || []).join(', '),
    vehicleId: '', driverKey: d.driverKey,
    total: d.total, series: seriesFor(d),
  })).sort(sortByTotalDesc)
)
function sortByTotalDesc(a, b) {
  const av = a.total?.miles, bv = b.total?.miles
  if (av == null && bv == null) return 0
  if (av == null) return 1
  if (bv == null) return -1
  return bv - av
}

function shortWeek(start, end) {
  return `${String(start).slice(5).replace('-', '/')}–${String(end).slice(5).replace('-', '/')}`
}
function fmtMi(v) {
  if (v == null) return '—'
  return Number(v).toLocaleString('en-US')
}

const BASIS = {
  eld: { label: 'ELD', cls: 'ok', title: 'Every day in this period was fully observed by the ELD.' },
  partial: { label: 'partly', cls: 'warn', title: 'Some of this period was not observed — the ELD was dark, or a reading was rejected. The real figure is higher.' },
  'no-data': { label: 'no data', cls: 'none', title: 'No ELD coverage at all for this period. This is not zero miles — it is an unknown.' },
}
function basisInfo(b) { return BASIS[b] || BASIS['no-data'] }

/* --- drill-down ---------------------------------------------------------- */
const drillOpen = ref(false)
const drillTitle = ref('')
const drillSubtitle = ref('')
const drillDetail = ref(null)
const drillLoading = ref(false)
const drillError = ref('')

function onWeekSelect(w) {
  selectedWeek.value = selectedWeek.value === w.weekStart ? '' : w.weekStart
}

async function onDrill({ row, period }) {
  // A row we cannot measure has nothing to itemise; opening an empty modal
  // would imply we looked and found nothing.
  const cell = period ? row.series.get(period.key) : row.total
  if (!cell || cell.miles == null) return
  if (!row.vehicleId && !row.driverKey) return

  const from = period ? period.key : data.value.from
  const to = period ? (period.end || period.key) : data.value.to
  drillTitle.value = row.name
  drillSubtitle.value = period
    ? `${period.label} · ${fmtMi(cell.miles)} mi`
    : `${data.value.from} → ${data.value.to} · ${fmtMi(cell.miles)} mi`
  drillDetail.value = null
  drillError.value = ''
  drillLoading.value = true
  drillOpen.value = true
  try {
    const qs = new URLSearchParams({ from, to })
    if (row.vehicleId) qs.set('vehicleId', row.vehicleId)
    else qs.set('driver', row.driverKey)
    drillDetail.value = await api.get(`/api/analytics/mileage/detail?${qs}`)
  } catch (e) {
    drillError.value = e.message || 'Could not load the detail for this period.'
  } finally {
    drillLoading.value = false
  }
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
/* ⚠️ MOST OF THIS PAGE'S CHROME IS **NOT** GLOBAL — it is scoped inside
   FinancialsView.vue and has to be copied in.
   GLOBAL (inherited, do not redefine): .admin-page, .page-header, .kpi-grid,
     .kpi-card (+ -label/-value/-sub), the modal-info and click-hint families,
     and the button / form / badge / pagination / skeleton primitives.
   SCOPED (must be copied): .section*, .data-warning*, .data-table,
     .loading-state, .error-state, .skeleton-card.
   An earlier version of this comment claimed .data-warning was global. It is
   not — it lives only in FinancialsView — so BOTH coverage notices on this page
   shipped as unstyled bare text. The section rules were caught from a
   screenshot; the warning was missed because its text still rendered, just
   without its card. */
.section {
  background: var(--surface, #fff);
  border: 1px solid var(--border, #d8dbe3);
  border-radius: 12px;
  padding: 1.25rem;
  margin-bottom: 1rem;
}
.section-title { display: flex; align-items: center; gap: 0.6rem; font-weight: 700; font-size: 0.95rem; margin-bottom: 1rem; }
.section-icon {
  width: 28px; height: 28px; border-radius: 8px;
  display: flex; align-items: center; justify-content: center;
  font-size: 0.85rem; font-weight: 700; flex: none;
}
.section-sub { margin-left: auto; font-size: 0.72rem; font-weight: 500; color: var(--text-dim, #6b7085); }
.kpi-grid { display: grid; grid-template-columns: repeat(auto-fit, minmax(180px, 1fr)); gap: 0.75rem; }

/* The honesty notices. These are the whole point of the page — a reader who
   takes a partial-fleet figure as complete is wrong by a large factor — so they
   must not render as anonymous grey text. */
.data-warning {
  background: #fef3c7;
  border: 1px solid #fcd34d;
  border-left: 4px solid #f59e0b;
  border-radius: 10px;
  padding: 0.85rem 1rem;
  color: #78350f;
  margin-bottom: 1rem;
}
.data-warning-title { font-weight: 700; font-size: 0.85rem; margin-bottom: 0.35rem; }
.data-warning-msg { font-size: 0.78rem; line-height: 1.5; }
/* Informational, not a warning: an unlinked ELD is a thing to fix, not a fault
   in the numbers shown. Neutral slate keeps the amber meaningful. */
.idle-warning { background: #f1f5f9; border-color: #cbd5e1; border-left-color: #64748b; color: #334155; }

.grain-row { display: flex; gap: 0.4rem; margin: 0 0 0.75rem; }
.grain-btn {
  padding: 0.35rem 0.8rem;
  border: 1px solid var(--border, #d8dbe3);
  background: var(--surface, #fff);
  border-radius: 999px; font-size: 0.82rem; font-weight: 600;
  color: var(--text-dim, #6b7085); cursor: pointer;
}
.grain-btn.active { background: var(--accent, #2563eb); border-color: var(--accent, #2563eb); color: #fff; }

.week-pin { margin-top: 0.5rem; font-size: 0.76rem; color: var(--text-dim, #6b7085); }
.linkish { border: 0; background: none; color: var(--accent, #2563eb); cursor: pointer; font-size: 0.76rem; text-decoration: underline; padding: 0 0.25rem; }

/* Wide period tables must scroll INSIDE their own container — the page body
   must never scroll horizontally. */
.basis-badge { display: inline-block; padding: 0.05rem 0.4rem; border-radius: 999px; font-size: 0.66rem; font-weight: 700; text-transform: uppercase; letter-spacing: 0.02em; }
.b-ok { background: #dcfce7; color: #166534; }
.b-warn { background: #fef3c7; color: #92400e; }
.b-none { background: #e5e7eb; color: #4b5563; }

.analytics-note { font-size: 0.76rem; color: var(--text-dim, #6b7085); margin: 0.3rem 0 0; line-height: 1.5; }

</style>
