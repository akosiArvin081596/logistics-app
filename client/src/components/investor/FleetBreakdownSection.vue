<template>
  <div class="section">
    <div class="section-title">
      <div class="section-icon" style="background: var(--amber-dim); color: var(--amber);">&#128203;</div>
      Per-Truck Breakdown
    </div>

    <div v-if="trucks.length === 0" class="empty-state">No trucks in database yet.</div>

    <table v-else class="fleet-table">
      <thead>
        <tr>
          <th></th>
          <th>Unit</th>
          <th>Make / Model</th>
          <th>Status</th>
          <th>Current Driver</th>
          <th
            class="clickable-header"
            role="button" tabindex="0"
            title="Click for explanation of how Loads is counted"
            @click="openDetail('loads')"
            @keyup.enter="openDetail('loads')"
            @keyup.space.prevent="openDetail('loads')"
          >Loads <span class="info-marker" aria-hidden="true">i</span></th>
          <th
            class="clickable-header"
            role="button" tabindex="0"
            title="Click for explanation of how Miles is derived"
            @click="openDetail('miles')"
            @keyup.enter="openDetail('miles')"
            @keyup.space.prevent="openDetail('miles')"
          >Miles <span class="info-marker" aria-hidden="true">i</span></th>
          <th
            class="clickable-header"
            role="button" tabindex="0"
            title="Click for explanation of Est. Your Revenue"
            @click="openDetail('estRevenue')"
            @keyup.enter="openDetail('estRevenue')"
            @keyup.space.prevent="openDetail('estRevenue')"
          >Est. Your Revenue <span class="info-marker" aria-hidden="true">i</span></th>
          <th
            class="clickable-header"
            role="button" tabindex="0"
            title="Click for explanation of how ROI is calculated"
            @click="openDetail('roi')"
            @keyup.enter="openDetail('roi')"
            @keyup.space.prevent="openDetail('roi')"
          >ROI <span class="info-marker" aria-hidden="true">i</span></th>
        </tr>
      </thead>
      <tbody>
        <template v-for="t in trucksWithROI" :key="t.id">
          <tr class="clickable-row" @click="toggleDetail(t.UnitNumber || t.unit_number)">
            <td class="photo-cell">
              <!-- Same full-size photo affordance as My Trucks — the investor sees
                   the same trucks in both tables, so only one being clickable
                   reads as a bug.
                   .stop is LOAD-BEARING here (My Trucks needs no equivalent):
                   this <tr> is a .clickable-row that toggles the expanded detail
                   row, so without it one click would open the lightbox AND
                   expand/collapse the row underneath it. -->
              <img
                v-if="t.Photo"
                :src="t.Photo"
                class="truck-thumb truck-thumb-clickable"
                :alt="t.UnitNumber"
                role="button"
                tabindex="0"
                :title="`View ${t.UnitNumber || 'truck'} full size`"
                @click.stop="zoomTruck = t"
                @keyup.enter.stop="zoomTruck = t"
                @keyup.space.stop.prevent="zoomTruck = t"
              />
              <div v-else class="truck-thumb-placeholder" :title="`No photo on file for ${t.UnitNumber || 'this truck'}`">&#128665;</div>
            </td>
            <td class="unit-num">{{ t.UnitNumber }}</td>
            <td>{{ [t.Make, t.Model].filter(Boolean).join(' ') || '\u2014' }}</td>
            <td>
              <span :class="['status-badge', statusClass(t.Status)]">{{ t.Status }}</span>
            </td>
            <td :style="{ color: t.AssignedDriver ? 'var(--text)' : 'var(--text-dim)' }">
              {{ t.AssignedDriver || '\u2014' }}
            </td>
            <td class="mono">{{ t.loadCount || 0 }}</td>
            <td class="mono">{{ (t.totalMiles || 0).toLocaleString() }}</td>
            <!-- estRevenue is null (not 0) for a truck that hasn't been in
                 service the whole trailing window — there is nothing to
                 average, which is a different statement from "earned $0".
                 Em dash + dim note, same convention as the unassigned-driver
                 cell above. -->
            <td class="mono">
              <template v-if="t.estRevenue === null">
                <span class="no-proj" :title="noProjectionTitle(t)">&#8212;</span>
                <!-- Falls back to a neutral phrase, not a reason, when no
                     in-service date is on file — don't assert a "why" the
                     data doesn't support. -->
                <span class="bd-hint block">{{ inServiceShort(t) ? `in service ${inServiceShort(t)}` : 'not yet projected' }}</span>
              </template>
              <template v-else>{{ fmt(t.estRevenue) }}</template>
            </td>
            <td>
              <!-- No badge at all without a projection: a "+0.0%" on a truck
                   three days old is a wrong answer, not a neutral one. -->
              <span v-if="t.roi === null" class="no-proj" :title="noProjectionTitle(t)">&#8212;</span>
              <span v-else :class="['roi-badge', t.roi >= 0 ? 'positive' : 'negative']">
                {{ t.roi >= 0 ? '+' : '' }}{{ t.roi.toFixed(1) }}%
              </span>
            </td>
          </tr>
          <!-- Expandable P&L breakdown -->
          <tr v-if="expandedUnit === (t.UnitNumber || t.unit_number)" class="detail-row">
            <td colspan="9">
              <div class="truck-detail">
                <div class="detail-header">{{ t.UnitNumber }} &middot; {{ [t.Make, t.Model].filter(Boolean).join(' ') }} &middot; {{ t.AssignedDriver || 'Unassigned' }}</div>
                <!-- "Monthly avg based on N months" is the fleet's operating
                     window, so it would contradict the "—" on a truck that
                     hasn't run that long. Swap it for the in-service fact. -->
                <div class="detail-sub">
                  {{ t.loadCount || 0 }} completed load{{ t.loadCount !== 1 ? 's' : '' }} &middot;
                  <template v-if="t.estRevenue === null">{{ inServiceLong(t) ? `In service since ${inServiceLong(t)}` : 'Not yet in service a full 3 months' }}</template>
                  <template v-else>Monthly avg based on {{ truckMonths(t) }} month{{ truckMonths(t) !== 1 ? 's' : '' }}</template>
                </div>
                <div class="detail-breakdown">
                  <div class="bd-row">
                    <span>Revenue ({{ t.loadCount || 0 }} load{{ t.loadCount !== 1 ? 's' : '' }})</span>
                    <span class="bd-val" style="color:var(--accent)">{{ fmt(perUnit(t)?.unitMonthlyGross) }}</span>
                  </div>
                  <div class="bd-row deduct">
                    <span>- Driver Pay</span>
                    <span class="bd-val">{{ fmt(-(driverPay(t))) }}<span class="bd-hint"> ({{ driverDays(t) }} days x ${{ driverRate(t) }})</span></span>
                  </div>
                  <div class="bd-row deduct">
                    <span>- Fixed Costs</span>
                    <span class="bd-val">{{ fmt(-(fixedCosts(t))) }}</span>
                  </div>
                  <div class="bd-row deduct">
                    <span>- Trip Expenses</span>
                    <span class="bd-val">{{ fmt(-(tripExp(t))) }}</span>
                  </div>
                  <div class="bd-divider"></div>
                  <div class="bd-row total">
                    <span>Monthly Net</span>
                    <span class="bd-val" :style="{color: monthlyNet(t) >= 0 ? 'var(--accent)' : 'var(--danger)'}">{{ fmt(monthlyNet(t)) }}</span>
                  </div>
                  <div class="bd-row">
                    <span>&times; 12 months</span>
                    <span class="bd-val"></span>
                  </div>
                  <div class="bd-row total">
                    <span>Est. Your Annual Take-Home</span>
                    <span v-if="t.estRevenue === null" class="bd-val no-proj" :title="noProjectionTitle(t)">&#8212;</span>
                    <span v-else class="bd-val" style="color:var(--blue)">{{ fmt(t.estRevenue) }}</span>
                  </div>
                  <div v-if="t.estRevenue === null" class="bd-row">
                    <span class="bd-hint">No projection yet &mdash; this truck hasn't run a full 3 months, so there's no average to annualise. Not a $0 forecast.</span>
                  </div>
                  <!-- Revenue is attributed to the truck named on the load.
                       When no load names a truck, the figures above fall back
                       to the assigned driver's loads — say so rather than
                       implying a per-truck measurement we don't have. -->
                  <div v-else-if="attributionMode(t) === 'driver-fallback'" class="bd-row">
                    <span class="bd-hint">Loads here don't name a truck, so these figures come from {{ t.AssignedDriver || 'the assigned driver' }}'s loads.</span>
                  </div>
                  <div class="bd-divider"></div>
                  <div v-if="t.roi !== null" class="bd-row">
                    <span>ROI ({{ fmt(t.estRevenue) }} / {{ fmt(truckPrice(t)) }})</span>
                    <span class="bd-val" :style="{color: t.roi >= 0 ? 'var(--accent)' : 'var(--danger)'}">{{ t.roi >= 0 ? '+' : '' }}{{ t.roi.toFixed(1) }}%</span>
                  </div>
                  <!-- breakEvenMonths is already null-safe: null is falsy, so
                       the row is omitted rather than rendering "null months". -->
                  <div v-if="t.breakEvenMonths" class="bd-row">
                    <span>Break-even</span>
                    <span class="bd-val">{{ t.breakEvenMonths }} months</span>
                  </div>
                </div>
              </div>
            </td>
          </tr>
        </template>
      </tbody>
      <tfoot>
        <tr>
          <td colspan="5" class="total-label">Fleet Total</td>
          <td class="mono total-val">{{ totalLoads }}</td>
          <td></td>
          <!-- Sums only the trucks that HAVE a projection. `null` is skipped,
               never coerced, so one un-projected truck can't turn the fleet
               total into NaN or drag it to $0. Un-projected trucks are named
               here so the total is never quietly short. -->
          <td class="mono total-val">
            {{ fmt(totalEstRevenue) }}
            <span v-if="unprojectedCount > 0" class="bd-hint block" :title="unprojectedTitle">
              {{ unprojectedCount }} truck{{ unprojectedCount === 1 ? '' : 's' }} not yet projected
            </span>
          </td>
          <td>
            <span :class="['roi-badge', fleetROI >= 0 ? 'positive' : 'negative']">
              {{ fleetROI >= 0 ? '+' : '' }}{{ fleetROI.toFixed(1) }}%
            </span>
          </td>
        </tr>
      </tfoot>
    </table>
    <div class="fleet-note">
      Est. Your Revenue = that truck's own trailing 3-month take-home × 12 — your share of the net profit its loads produced, after driver pay, fixed costs and trip expenses. Each truck is projected from its own loads, so trucks in the same fleet will differ. ROI = Est. Your Revenue / Purchase Price × 100. A &ldquo;&mdash;&rdquo; means the truck hasn't been in service a full 3 months yet, so there's nothing to average from — it isn't a $0 forecast, and it's left out of the Fleet Total. Based on {{ monthsLabel }} of data — projections become more accurate over time.
    </div>

    <!-- Detail modal -->
    <!-- Full-size vehicle photo, same shared viewer as My Trucks and the
         Expenses receipt preview. Teleports to <body>, so its position here
         is cosmetic. -->
    <ZoomableImage
      v-if="zoomTruck"
      :src="zoomTruck.Photo"
      :alt="`${zoomTruck.UnitNumber || 'Truck'}${zoomTruck.Year || zoomTruck.Make || zoomTruck.Model ? ' — ' : ''}${[zoomTruck.Year, zoomTruck.Make, zoomTruck.Model].filter(Boolean).join(' ')}`"
      @close="zoomTruck = null"
    />

    <MetricInfoDialog
      :open="!!detailType"
      :title="modalTitle"
      :subtitle="modalSubtitle"
      @update:open="v => { if (!v) detailType = '' }"
    >
      <!-- Loads -->
      <template v-if="detailType === 'loads'">
        <div class="modal-breakdown">
          <div class="modal-explain">
            For each truck in the table, this is the number of completed loads that truck has hauled since being added to your fleet.
          </div>
          <div class="step-label">What Counts</div>
          <div class="modal-explain-sm">
            Only loads that <strong>completed delivery</strong>. Cancelled or soft-deleted loads are excluded by the standard load-exclusion filter, so the count matches every other live-loads number on this page.
          </div>
          <div class="modal-divider"></div>
          <div class="modal-row bold result">
            <span>Fleet Total Loads</span>
            <span class="val accent">{{ totalLoads }}</span>
          </div>
        </div>
      </template>

      <!-- Miles -->
      <template v-if="detailType === 'miles'">
        <div class="modal-breakdown">
          <div class="modal-explain">
            Total miles each truck has driven since odometer data started being captured. Sourced from Routemate ELD telemetry.
          </div>
          <div class="step-label">How It's Computed</div>
          <div class="modal-explain-sm">
            For each truck: <code>MAX(odometer) - MIN(odometer)</code> across all telemetry pings. Trucks without ELD data show 0.
          </div>
          <div class="modal-callout info">
            Miles can lag the actual odometer by a few hours while telemetry catches up. The most recent trip may not yet be reflected.
          </div>
        </div>
      </template>

      <!-- Est. Your Revenue -->
      <template v-if="detailType === 'estRevenue'">
        <div class="modal-breakdown">
          <div class="modal-explain">
            <strong>Est. Your Revenue</strong> is a forward-looking projection of what each truck will pay you over the next 12 months &mdash; your share of the net profit that truck's own loads produced, annualised from its trailing 3-month average.
          </div>
          <div class="step-label">The Calculation (per truck)</div>
          <div class="modal-explain-sm">
            1. Take the last 3 months of revenue from the loads <strong>that truck</strong> hauled.<br>
            2. Subtract driver pay, fixed costs and trip expenses, then apply your profit split.<br>
            3. Multiply that monthly take-home by 12.
          </div>
          <div class="modal-hint">
            Each truck is measured on its own loads, so two trucks in one fleet won't show the same number. Where a load doesn't name a truck, its assigned driver's loads are used instead.
          </div>
          <div class="step-label">Why a truck can show &ldquo;&mdash;&rdquo;</div>
          <div class="modal-explain-sm">
            A truck needs a full 3 months in service before there is anything to average. Until then it shows &ldquo;&mdash;&rdquo; instead of a projection, and it is left out of the Fleet Total below. That is <strong>not</strong> a forecast of $0 &mdash; it simply isn't measurable yet. A truck that <em>has</em> been in service the whole window but produced nothing shows $0.
          </div>
          <div class="modal-divider"></div>
          <div class="modal-row bold result">
            <span>Fleet Total (Est. Your Revenue)</span>
            <span class="val accent">{{ fmt(totalEstRevenue) }}</span>
          </div>
          <div v-if="unprojectedCount > 0" class="modal-hint">
            Excludes {{ unprojectedCount }} truck{{ unprojectedCount === 1 ? '' : 's' }} with no projection yet: {{ unprojectedNames }}.
          </div>
          <div class="modal-callout warning">
            This is an estimate, not a guarantee. Freight market swings, maintenance, or a driver change can shift it quickly.
          </div>
        </div>
      </template>

      <!-- ROI -->
      <template v-if="detailType === 'roi'">
        <div class="modal-breakdown">
          <div class="modal-explain">
            Per-truck Return on Investment. Compares each truck's estimated annual take-home to its purchase price &mdash; how much of the original outlay you'd earn back in a year.
          </div>
          <div class="step-label">The Calculation (per truck)</div>
          <!-- Worked example uses the first truck that actually HAS a
               projection — anchoring it to row 0 showed "$0" whenever the
               top row was an un-projected truck. -->
          <div class="modal-row">
            <span>Est. Annual Take-Home</span>
            <span class="val accent">e.g. {{ fmt(exampleTruck?.estRevenue || 0) }}</span>
          </div>
          <div class="modal-row deduct">
            <span>&divide; Truck Purchase Price</span>
            <span class="val">e.g. {{ fmt(truckPrice(exampleTruck || {})) }}</span>
          </div>
          <div class="modal-row split-row">
            <span>&times; 100 (percent)</span>
            <span></span>
          </div>
          <div class="modal-hint">
            A truck with no projection yet shows &ldquo;&mdash;&rdquo; here too, rather than 0% &mdash; there is no take-home figure to divide.
          </div>
          <div class="modal-divider"></div>
          <div class="modal-row bold result">
            <span>Fleet ROI</span>
            <span class="val" :class="fleetROI >= 0 ? 'accent' : 'danger'">{{ fleetROI >= 0 ? '+' : '' }}{{ fleetROI.toFixed(1) }}%</span>
          </div>
          <div class="modal-callout info">
            A 30% ROI means the truck would generate take-home equivalent to about 30% of its purchase price in a year &mdash; or stated differently, it would pay for itself in roughly {{ fleetROI > 0 ? (100 / fleetROI).toFixed(1) : 'N/A' }} years at the current run rate.
          </div>
        </div>
      </template>
    </MetricInfoDialog>
  </div>
</template>

<script setup>
import { ref, computed } from 'vue'
import { formatCurrency as fmt } from '../../utils/format'
import MetricInfoDialog from './MetricInfoDialog.vue'
import ZoomableImage from '../shared/ZoomableImage.vue'

const props = defineProps({
  trucks: { type: Array, default: () => [] },
  asset: { type: Object, default: () => ({}) },
  production: { type: Object, default: () => ({}) },
})

const expandedUnit = ref(null)
function toggleDetail(unit) { expandedUnit.value = expandedUnit.value === unit ? null : unit }

// The truck whose photo is open full-size, or null. Mirrors MyTrucks.vue —
// holds the whole row so the viewer can name the vehicle, not just show pixels.
const zoomTruck = ref(null)

function perUnit(t) {
  const key = t.UnitNumber || t.unit_number || ''
  return (props.production?.perTruckData || {})[key] || {}
}
// 'truck' = revenue came from loads naming this unit; 'driver-fallback' = no
// load named a truck, so the assigned driver's loads stood in; 'no-data' = the
// fleet has truck-level revenue but none of it is this truck's.
function attributionMode(t) { return perUnit(t).attributionMode || '' }

const MONTH_NAMES = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec']

// GET /api/trucks serializes InServiceDate; read the snake_case spelling too,
// the way TruckTable.vue does, so the value survives either serialization.
function inServiceRaw(t) {
  return String(t?.InServiceDate ?? t?.in_service_date ?? '').trim()
}

// Splits 'YYYY-MM-DD' by string math only. NEVER `new Date(iso)` — that parses
// as UTC midnight and renders as the PREVIOUS day everywhere in the US, which
// would date a truck to the day before it went into service. Same rule as
// TruckTable.vue's formatInServiceDate.
function splitIsoDate(raw) {
  const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(raw)
  if (!m) return null
  const month = MONTH_NAMES[Number(m[2]) - 1]
  return month ? { year: m[1], month, day: String(Number(m[3])) } : null
}

// Compact form for the table cell. A truck too new to project is normally
// weeks old, so 'Aug 4' reads cleanly; the year is appended only when it
// isn't the current one, which is what stops a late-December in-service date
// looking eleven months stale in January.
function inServiceShort(t) {
  const p = splitIsoDate(inServiceRaw(t))
  if (!p) return ''
  return Number(p.year) === new Date().getFullYear() ? `${p.month} ${p.day}` : `${p.month} ${p.day}, ${p.year}`
}
function inServiceLong(t) {
  const p = splitIsoDate(inServiceRaw(t))
  return p ? `${p.month} ${p.day}, ${p.year}` : ''
}
function noProjectionTitle(t) {
  const unit = t?.UnitNumber || t?.unit_number || 'This truck'
  const when = inServiceLong(t)
  return when
    ? `No projection yet — ${unit} went into service ${when}, so it hasn't run a full 3 months to average from. This is not a forecast of $0.`
    : `No projection yet — ${unit} hasn't been in service a full 3 months, so there is nothing to average from. This is not a forecast of $0.`
}
function truckPrice(t) { return t.PurchasePrice || t.purchase_price || props.asset?.purchasePrice || 0 }
function truckMonths(t) { return props.production?.monthsOfOperation || 1 }
function driverPay(t) {
  const driver = (t.AssignedDriver || t.assigned_driver || '').trim().toLowerCase()
  return (props.production?.driverPayDetails || {})[driver]?.totalPay || 0
}
function driverDays(t) {
  const driver = (t.AssignedDriver || t.assigned_driver || '').trim().toLowerCase()
  return (props.production?.driverPayDetails || {})[driver]?.activeDays || 0
}
function driverRate(t) {
  const driver = (t.AssignedDriver || t.assigned_driver || '').trim().toLowerCase()
  return (props.production?.driverPayDetails || {})[driver]?.dailyRate || 300
}
function fixedCosts(t) {
  const pu = perUnit(t)
  return (pu.unitMonthlyExpenses || 0) - (driverPay(t) / (truckMonths(t) || 1)) - tripExp(t)
}
function tripExp(t) {
  // tripExp = unitMonthlyExpenses - fixedCosts - driverPay/months
  // We don't have tripExp separately, so derive: total expenses - driverPay - (monthlyGross - monthlyNet - driverPay)
  // Simpler: just show unitMonthlyExpenses breakdown note
  return 0 // TODO: backend doesn't send per-truck trip expenses separately yet
}
function monthlyNet(t) {
  const pu = perUnit(t)
  return (pu.unitMonthlyGross || 0) - (pu.unitMonthlyExpenses || 0)
}

const trucksWithROI = computed(() => {
  const perTruckData = props.production?.perTruckData || {}
  const grossRevenue = props.production?.totalRevenue || 0
  const purchasePrice = props.asset?.purchasePrice || 0

  return props.trucks.map(t => {
    const unitKey = t.UnitNumber || t.unit_number || ''
    const perUnit = perTruckData[unitKey]
    // Investor take-home, NOT gross. Per the 2026-04-12 meeting: "all these
    // metrics has to be based on what the investor is actually taking home".
    // The backend computes estAnnualInvestorRevenue from THIS truck's trailing
    // 3-month investor earnings × 12.
    //
    // Tri-state, and the three states mean different things:
    //   number  → a projection
    //   0       → in service the whole window, genuinely produced nothing
    //   null    → too new to project; there is no 3-month window to average
    // Anything non-finite (undefined for a truck absent from perTruckData, or
    // a malformed value) collapses to null rather than 0, so the UI says
    // "unknown" instead of asserting a $0 forecast it can't support.
    const rawEst = perUnit?.estAnnualInvestorRevenue
    const estRevenue = Number.isFinite(Number(rawEst)) && rawEst !== null && rawEst !== ''
      ? Number(rawEst)
      : null
    const truckPrice = t.PurchasePrice || t.purchase_price || purchasePrice
    // ROI = estimated annual investor take-home / truck investment cost.
    // null propagates: without a take-home figure there is no ratio, and
    // rendering "+0.0%" on a week-old truck is its own wrong answer.
    const roi = estRevenue === null
      ? null
      : (truckPrice > 0 ? (estRevenue / truckPrice) * 100 : 0)
    const totalMiles = perUnit?.totalMiles ?? 0
    const loadCount = perUnit?.loadCount ?? 0
    const breakEvenMonths = perUnit?.breakEvenMonths ?? null
    return { ...t, estRevenue, roi, totalMiles, loadCount, breakEvenMonths }
  })
})

// Sums real numbers only. A null must never coerce into the total — the fleet
// figure has to stay a true sum of the trucks that have a projection, and the
// count of the ones it omits is surfaced next to it.
const totalEstRevenue = computed(() =>
  trucksWithROI.value.reduce((s, t) => s + (Number.isFinite(t.estRevenue) ? t.estRevenue : 0), 0)
)
const totalLoads = computed(() => trucksWithROI.value.reduce((s, t) => s + (t.loadCount || 0), 0))

const unprojectedTrucks = computed(() => trucksWithROI.value.filter(t => t.estRevenue === null))
const unprojectedCount = computed(() => unprojectedTrucks.value.length)
const unprojectedNames = computed(() =>
  unprojectedTrucks.value.map(t => t.UnitNumber || t.unit_number || 'unnamed truck').join(', ')
)
const unprojectedTitle = computed(() => {
  const list = unprojectedNames.value
  return `Not included in this total: ${list}. ${unprojectedCount.value === 1 ? 'This truck has' : 'These trucks have'} not been in service a full 3 months, so there is no projection to add.`
})
// Worked example for the ROI modal: the first truck that actually has a
// projection, so the illustration never reads "$0 / $0".
const exampleTruck = computed(() =>
  trucksWithROI.value.find(t => Number.isFinite(t.estRevenue) && t.estRevenue > 0)
  || trucksWithROI.value.find(t => Number.isFinite(t.estRevenue))
  || trucksWithROI.value[0]
  || null
)
// Fleet ROI = total est annual net / total fleet purchase price
const fleetROI = computed(() => {
  const totalPrice = props.production?.totalPurchasePrice || props.asset?.purchasePrice || 0
  if (totalPrice === 0) return 0
  return (totalEstRevenue.value / totalPrice) * 100
})

const monthsLabel = computed(() => {
  const m = props.production?.monthsOfOperation || 1
  return m + ' month' + (m !== 1 ? 's' : '')
})

function statusClass(status) {
  if (status === 'Active') return 'status-active'
  if (status === 'Inactive') return 'status-inactive'
  return 'status-maintenance'
}

// --- Detail modal ---
const detailType = ref('')
function openDetail(type) { detailType.value = type }

const MODAL_CONFIG = {
  loads: { title: 'Loads (per truck)', subtitle: 'How completed loads are counted' },
  miles: { title: 'Miles (per truck)', subtitle: 'How miles are derived from ELD telemetry' },
  estRevenue: { title: 'Est. Your Revenue', subtitle: 'Projected 12-month take-home, per truck' },
  roi: { title: 'ROI', subtitle: 'Annual take-home as % of purchase price' },
}

const modalTitle = computed(() => MODAL_CONFIG[detailType.value]?.title || '')
const modalSubtitle = computed(() => MODAL_CONFIG[detailType.value]?.subtitle || '')
</script>

<style scoped>
.section {
  background: var(--surface); border: 1px solid var(--border);
  border-radius: var(--radius); padding: 1.25rem; margin-bottom: 1.25rem;
}
.section-title {
  font-size: 0.95rem; font-weight: 700; margin-bottom: 1rem;
  display: flex; align-items: center; gap: 0.5rem;
}
.section-icon {
  width: 28px; height: 28px; border-radius: 8px;
  display: flex; align-items: center; justify-content: center; font-size: 0.9rem;
}
.empty-state { text-align: center; color: var(--text-dim); font-size: 0.85rem; padding: 2rem 0; }

.fleet-table {
  width: 100%; border-collapse: separate; border-spacing: 0;
  font-size: 0.82rem;
}
.fleet-table th {
  text-align: left; padding: 0.6rem 0.5rem; font-weight: 600;
  color: var(--text-dim); border-bottom: 2px solid var(--border);
  font-size: 0.68rem; text-transform: uppercase; letter-spacing: 0.06em;
}
.fleet-table th.clickable-header {
  cursor: pointer; user-select: none; transition: color 0.15s ease;
}
.fleet-table th.clickable-header:hover { color: var(--accent); }
.fleet-table th.clickable-header:focus-visible {
  outline: 2px solid var(--accent); outline-offset: 2px; color: var(--accent);
}
.info-marker {
  display: inline-flex; align-items: center; justify-content: center;
  width: 14px; height: 14px; border-radius: 50%;
  background: var(--accent-dim); color: var(--accent);
  font-size: 0.6rem; font-weight: 800; font-style: normal;
  margin-left: 0.25rem; text-transform: lowercase;
}
.fleet-table td {
  padding: 0.65rem 0.5rem; border-bottom: 1px solid var(--bg); vertical-align: middle;
}
.fleet-table tbody tr:hover { background: var(--bg); }
.fleet-table tfoot td {
  padding: 0.75rem 0.5rem; border-top: 2px solid var(--border);
  font-weight: 700;
}

.photo-cell { width: 42px; padding: 0.3rem 0.25rem; }
.truck-thumb {
  width: 38px; height: 28px; object-fit: cover;
  border-radius: 4px; display: block;
}
/* Only applied when a photo exists, so the affordance never lies. Matches
   MyTrucks.vue — same trucks, same interaction, wherever the investor meets them.
   zoom-in overrides the row's own pointer cursor, which is the visual cue that
   this cell does something different from the rest of the (expandable) row. */
.truck-thumb-clickable {
  cursor: zoom-in;
  transition: transform 0.12s ease, box-shadow 0.12s ease;
}
.truck-thumb-clickable:hover { transform: scale(1.12); box-shadow: 0 2px 8px rgba(0, 0, 0, 0.25); }
.truck-thumb-clickable:focus-visible {
  outline: 2px solid var(--accent, #6366f1);
  outline-offset: 2px;
}
@media (prefers-reduced-motion: reduce) {
  .truck-thumb-clickable { transition: none; }
  .truck-thumb-clickable:hover { transform: none; }
}
.truck-thumb-placeholder {
  width: 38px; height: 28px; border-radius: 4px;
  background: var(--bg); display: flex; align-items: center;
  justify-content: center; font-size: 1rem; color: var(--text-dim);
}
.unit-num { font-family: 'JetBrains Mono', monospace; font-weight: 600; }
.mono { font-family: 'JetBrains Mono', monospace; }
.total-label { text-align: right; }
.total-val { color: var(--accent); }

.status-badge {
  display: inline-flex; padding: 0.2rem 0.6rem; border-radius: 12px;
  font-size: 0.68rem; font-weight: 600; font-family: 'JetBrains Mono', monospace;
}
.status-active { background: var(--accent-dim); color: var(--accent); }
.status-inactive { background: var(--bg); color: var(--text-dim); }
.status-maintenance { background: var(--amber-dim); color: var(--amber); }

.roi-badge {
  display: inline-flex; padding: 0.15rem 0.5rem; border-radius: 8px;
  font-size: 0.72rem; font-weight: 700; font-family: 'JetBrains Mono', monospace;
}
.roi-badge.positive { background: var(--accent-dim); color: var(--accent); }
.roi-badge.negative { background: var(--danger-dim); color: var(--danger); }

/* "No projection" em dash. Dimmed like the unassigned-driver cell, with the
   help cursor MyTrucks/TruckTable use to advertise a tooltip. */
.no-proj { color: var(--text-dim); cursor: help; }
/* Inline caveat inside the P&L breakdown. The class was already used by the
   driver-pay row but never actually defined anywhere, so it rendered at full
   weight; these are the properties the surrounding notes (.fleet-note,
   .modal-hint) use for exactly this job. */
.bd-hint { font-size: 0.68rem; color: var(--text-dim); font-style: italic; }
/* Block variant for the table cells: the note sits under the value, and drops
   out of the monospace/bold the numeric cells set so it reads as prose. */
.bd-hint.block {
  display: block; margin-top: 0.1rem; line-height: 1.25;
  font-family: 'DM Sans', sans-serif; font-weight: 400;
  color: var(--text-dim); white-space: normal;
}
.fleet-note {
  font-size: 0.68rem; color: var(--text-dim); font-style: italic;
  margin-top: 0.75rem; padding: 0.5rem 0; border-top: 1px solid var(--bg);
  line-height: 1.5;
}
</style>
