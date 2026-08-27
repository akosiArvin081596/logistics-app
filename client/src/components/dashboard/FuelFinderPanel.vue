<template>
  <!-- Floating fuel + route-tools card, shown when a single driver is focused.
       Holds three things Deshorn asked for:
        #3  a "miles left in tank" range readout (hidden when the truck has no
            fuel sensor / no data),
        #2  a toggle that plots diesel truck stops on the map (parent renders
            the markers; this only owns the on/off state + fetch), and
        #4  a cheapest-diesel list = the along-route stops sorted by distance
            from the route, labeled honestly as a regional average.
       Every endpoint may 404 pre-integration → each section degrades to its own
       loading / empty / error state and never blocks the others. -->
  <div class="fuel-finder" :class="{ collapsed }">
    <button class="ff-toggle" :aria-expanded="!collapsed" @click="collapsed = !collapsed">
      <span class="ff-pump" aria-hidden="true">
        <svg viewBox="0 0 24 24" width="13" height="13" fill="currentColor">
          <path d="M19.77 7.23l.01-.01-3.72-3.72L15 4.56l2.11 2.11c-.94.36-1.61 1.26-1.61 2.33 0 1.38 1.12 2.5 2.5 2.5.36 0 .69-.08 1-.21v7.21c0 .55-.45 1-1 1s-1-.45-1-1V14c0-1.1-.9-2-2-2h-1V5c0-1.1-.9-2-2-2H6c-1.1 0-2 .9-2 2v16h9v-7.5h1.5v5c0 1.38 1.12 2.5 2.5 2.5s2.5-1.12 2.5-2.5V9c0-.69-.28-1.32-.73-1.77zM12 10H6V5h6v5z" />
        </svg>
      </span>
      <span class="ff-title-text">Fuel &amp; Route</span>
      <!-- Collapsed, this badge is the whole panel. It carries the VERDICT when
           there is one to give and the planning figure otherwise — never
           `rangeMiles`, which is the tank x mpg point estimate that put "449 mi
           left" in front of a truck with about 210. -->
      <span
        v-if="headerBadge"
        class="ff-range-badge"
        :class="'hb-' + headerBadge.tone"
        :title="headerBadge.title"
      >{{ headerBadge.text }}</span>
      <span class="ff-chevron" :class="{ open: !collapsed }" aria-hidden="true">&#9662;</span>
    </button>

    <div v-show="!collapsed" class="ff-body">
      <!-- #3 FUEL RANGE -->
      <div v-if="rangeLoading" class="ff-loading">Reading fuel level…</div>
      <div v-else-if="hasFuelData" class="ff-range">
        <div class="ff-ring" :class="{ low: fuelLow }" role="img" :aria-label="`Fuel ${Math.round(range.fuelPct)} percent`">
          <svg viewBox="0 0 36 36">
            <circle class="ff-ring-bg" cx="18" cy="18" r="15.9155" />
            <circle class="ff-ring-fg" cx="18" cy="18" r="15.9155" :stroke-dasharray="`${ringPct} 100`" />
          </svg>
          <span class="ff-ring-label">{{ Math.round(range.fuelPct) }}%</span>
        </div>
        <div class="ff-range-info">
          <!-- THE RUN-OUT LINE. The headline is the USABLE figure — how far
               this truck may go before a stop is mandatory — because that is
               the number a dispatcher acts on. Distance-to-dry sits under it,
               labelled, so the reserve is visible rather than implied. Both
               come off the same interval as before; nothing here re-derives a
               range, and rangeMiles is still never rendered.
               Pre-reserve servers (no reserveMiles) fall back to the original
               "mi to plan on" readout rather than inventing a buffer. -->
          <div v-if="interval.hasReserve && !interval.mustRefuelNow" class="ff-range-miles">
            <span class="ff-range-num">{{ milesText(interval.usable) }}</span>
            <span class="ff-unit">mi before you refuel</span>
            <span
              v-if="interval.basisInfo"
              class="ff-src"
              :class="basisBadgeClass"
              :title="interval.basisInfo.title"
            >{{ interval.basisInfo.short }}</span>
          </div>
          <!-- 0 usable miles is an INSTRUCTION, not a measurement. Rendering it
               as "0 mi before you refuel" reads as a dry tank; the truck in
               fact still has the reserve under it. -->
          <div v-else-if="interval.hasReserve" class="ff-range-miles">
            <span class="ff-range-num ff-now">Refuel now</span>
            <span
              v-if="interval.basisInfo"
              class="ff-src"
              :class="basisBadgeClass"
              :title="interval.basisInfo.title"
            >{{ interval.basisInfo.short }}</span>
          </div>
          <!-- The LOW end of the interval, labelled as such. Anything else here
               is a promise the truck has not been measured keeping. -->
          <div v-else class="ff-range-miles">
            <span class="ff-range-num">{{ interval.known ? milesText(interval.planning) : '—' }}</span>
            <span class="ff-unit">mi to plan on</span>
            <span
              v-if="interval.basisInfo && interval.known"
              class="ff-src"
              :class="basisBadgeClass"
              :title="interval.basisInfo.title"
            >{{ interval.basisInfo.short }}</span>
          </div>
          <!-- Names the buffer on screen. Before this it appeared in exactly one
               string in the whole client — "incl. 15 reserve", inside the trip
               verdict — which only renders once a routed load is selected. That
               is why the client asked for a line he was, correctly, not seeing. -->
          <div v-if="interval.hasReserve" class="ff-range-dry">
            {{ milesText(interval.planning) }} mi to dry · holds back
            {{ milesText(interval.reserve) }} mi reserve
          </div>
          <div v-if="interval.hasSpread" class="ff-range-spread">
            typical {{ milesText(interval.typical) }} · best {{ milesText(interval.high) }}
          </div>
          <!-- Null on purpose, so it is said in words. Substituting rangeMiles
               here would restore the original bug in one line. -->
          <div v-else-if="interval.known" class="ff-range-spread muted">
            no typical or best case yet — too few fill-ups on this truck
          </div>
          <div v-if="evidenceText" class="ff-range-evidence" title="Tank-to-tank legs behind the measured basis">
            {{ evidenceText }}
          </div>
          <div class="ff-range-sub">
            <span v-if="range.gallonsRemaining != null">{{ round1(range.gallonsRemaining) }} / {{ round1(range.tankGallons) }} gal</span>
            <span v-if="range.mpg" class="ff-mpg">
              {{ round1(range.mpg) }} mpg
              <span v-if="mpgSrc" class="ff-src" :class="mpgBadgeClass" :title="mpgSrc.title">
                {{ mpgSrc.short }}
              </span>
            </span>
          </div>
          <!-- The reading is INFERRED, and that has to be said. This truck's
               sensor drops to 0 while driving ~47% of the time; the figure above
               is the last credible reading minus the fuel burned since, so it is
               a floor, not a gauge. Silently showing it as if it were live is how
               the original bug felt trustworthy. -->
          <div v-if="carriedNote" class="ff-range-carried" :title="carriedNote.title">
            {{ carriedNote.text }}
          </div>
        </div>
      </div>
      <!-- ⚠️ NEVER RENDER NOTHING. This branch did not exist, so a truck whose
           ELD reports no fuel produced a completely empty panel — no number, no
           placeholder, no reason. A blank space reads as "fine"; that is the
           failure mode that put a driver on the shoulder. Say what is missing. -->
      <div v-else class="ff-range-none">
        <div class="ff-range-none-head">No fuel reading</div>
        <div class="ff-range-none-sub">{{ noFuelReason }}</div>
      </div>

      <!-- TRIP VERDICT — "does the rest of this load's route fit in the tank?"
           The server decides this on the low end and derates an unmeasured basis
           first; nothing here re-compares the numbers. -->
      <div v-if="planLoading" class="ff-loading">Checking the route against the tank…</div>
      <div v-else-if="verdict" class="ff-plan" :class="'v-' + verdict.tone">
        <div class="ff-plan-head" :title="verdict.title">{{ verdict.dispatch }}</div>
        <div class="ff-plan-rows">
          <div v-if="plan.routeMiles != null">
            <span>route left</span>
            <strong>{{ milesText(plan.routeMiles) }} mi</strong>
          </div>
          <div v-if="plan.requiredMiles != null">
            <span>needs</span>
            <strong>{{ milesText(plan.requiredMiles) }} mi</strong>
            <em v-if="plan.reserveMiles != null">incl. {{ milesText(plan.reserveMiles) }} reserve</em>
          </div>
          <div v-if="shortfallText">
            <span>short by</span>
            <strong class="bad">{{ shortfallText }}</strong>
          </div>
          <div v-if="refuelText">
            <span>refuel</span>
            <strong>{{ refuelText }}</strong>
          </div>
          <!-- pointsNeeded is the trustworthy half of this pair: measured, and
               free of both tank size and MPG. gallonsNeeded inherits mpgSource
               and is a LOWER bound, so it is labelled "at least". -->
          <div v-if="plan.pointsNeeded != null">
            <span>gauge</span>
            <strong>{{ plan.pointsNeeded }} points</strong>
          </div>
          <div v-if="plan.gallonsNeeded != null">
            <span>fuel</span>
            <strong>at least {{ round1(plan.gallonsNeeded) }} gal</strong>
          </div>
        </div>
        <div v-for="c in planCaveats" :key="c" class="ff-plan-caveat">{{ c }}</div>
        <!-- Kept visible, kept small, and kept explicitly out of the verdict.
             Dispatch watched this panel read 449 last week; silently swapping in
             a different number without saying so invites a bug report and, worse,
             a call to the driver quoting the old figure. -->
        <div v-if="plan.pointEstimateMiles != null" class="ff-plan-old">
          old tank × mpg formula: {{ milesText(plan.pointEstimateMiles) }} mi — not used
        </div>
      </div>
      <div v-else-if="planNote" class="ff-muted ff-plan-note">{{ planNote }}</div>
      <!-- Terminal fallback: the three branches above are all conditional, so a
           404 (planNote deliberately '') or simply no selected load left this
           whole section rendering nothing at all. Same rule as the range block —
           an absent verdict must be stated, never implied by blank space. -->
      <div v-else class="ff-muted ff-plan-note">{{ noPlanReason }}</div>

      <!-- #2 map toggle + #4 cheapest-diesel list -->
      <div class="ff-stops">
        <div class="ff-stops-head">
          <span class="ff-stops-title">Diesel truck stops</span>
          <button
            v-if="stops.length"
            class="ff-map-toggle"
            :class="{ on: showStops }"
            role="switch"
            :aria-checked="showStops"
            :title="showStops ? 'Hide truck stops on the map' : 'Show truck stops on the map'"
            @click="toggleStops"
          >
            <span class="ff-switch"><span class="ff-knob"></span></span>
            <span class="ff-map-label">Map</span>
          </button>
        </div>

        <div v-if="stopsLoading" class="ff-loading">Finding truck stops along the route…</div>
        <div v-else-if="stopsError" class="ff-muted">{{ stopsError }}</div>
        <template v-else-if="stops.length">
          <div class="ff-price-note" :class="{ live: livePriceCount > 0 }">
            <template v-if="livePriceCount > 0">
              Live diesel pump prices, cheapest first. Stations without a published price show “price n/a.”
            </template>
            <template v-else>
              No live diesel prices published for stops on this route yet.
            </template>
          </div>
          <ul class="ff-stop-list">
            <li v-for="(s, i) in stops" :key="s.placeId || i">
              <button class="ff-stop" @click="$emit('focus', { lat: s.lat, lng: s.lng, name: s.name })">
                <span class="ff-stop-main">
                  <span class="ff-stop-name">
                    <span v-if="i === cheapestIdx" class="ff-cheapest">Cheapest</span>
                    <span v-if="s.brand && brandDiffersFromName(s)" class="ff-stop-brand">{{ s.brand }}</span>
                    {{ s.name || s.brand || 'Truck stop' }}
                  </span>
                  <span v-if="s.address" class="ff-stop-addr">{{ s.address }}</span>
                  <span v-if="s.aboutMilesFromRoute != null" class="ff-stop-dist">~{{ round1(s.aboutMilesFromRoute) }} mi off route</span>
                </span>
                <span class="ff-stop-price">
                  <template v-if="priceOf(s) != null">
                    <span class="ff-price-row">
                      <span class="ff-price live">${{ priceOf(s) }}</span>
                      <span class="ff-price-unit">/gal</span>
                    </span>
                    <span class="ff-price-tag tag-live">live</span>
                  </template>
                  <span v-else class="ff-price-na">price n/a</span>
                </span>
              </button>
            </li>
          </ul>
        </template>
        <div v-else class="ff-muted">No truck stops found along this route.</div>
      </div>

      <div v-if="isEmpty" class="ff-muted ff-empty">No live fuel or route data for this driver yet.</div>
    </div>
  </div>
</template>

<script setup>
import { ref, computed, watch } from 'vue'
import { useApi } from '../../composables/useApi'
import {
  mpgSource,
  rangeReadout,
  planRangeReadout,
  tripVerdict,
  rangeEvidenceText,
  milesText,
} from '../../lib/fuelReview'
import { priceText, cheapestIndex } from '../../lib/fuelStops'

const api = useApi()

const props = defineProps({
  driver: { type: String, default: '' },
  loadId: { type: String, default: '' },
  // Active load object from /api/locations/latest (carries origin/dest coords)
  // — used as a fallback query when no loadId is available.
  activeLoad: { type: Object, default: null },
})

const emit = defineEmits(['stops', 'show', 'focus'])

const range = ref(null)
const rangeLoading = ref(false)
const plan = ref(null)
const planLoading = ref(false)
const planNote = ref('')
const stops = ref([])
const stopsLoading = ref(false)
const stopsError = ref('')
const showStops = ref(false)
const collapsed = ref(false)
const livePriceCount = ref(0)

// Price rule and cheapest-stop rule both live in lib/fuelStops.js, shared with
// the map pins in TrackingMap.vue and the driver's card strip. The map now
// prints these same numbers ON the pins, so a local copy of the guard here is
// how the pin and the row beside it would come to disagree.
const cheapestIdx = computed(() => cheapestIndex(stops.value))
function priceOf(s) {
  return priceText(s)
}

const hasFuelData = computed(() => !!(range.value && range.value.hasFuelData))
const fuelLow = computed(
  () => hasFuelData.value && range.value.fuelPct != null && range.value.fuelPct <= 25,
)
const ringPct = computed(() =>
  hasFuelData.value ? Math.max(0, Math.min(100, Number(range.value.fuelPct) || 0)) : 0,
)
// MPG provenance chip, ranked in lib/fuelReview: receipts (2) > eld (1) >
// default (0). Was a boolean against 'eld', which would have shown the new
// receipt-derived figure — the most accurate one available — as a grey "est".
// Unknown/absent yields null and the chip is omitted rather than guessed.
const mpgSrc = computed(() => mpgSource(range.value && range.value.mpgSource))
const mpgBadgeClass = computed(() =>
  !mpgSrc.value ? '' : (mpgSrc.value.rank === 2 ? 'src-best' : mpgSrc.value.rank === 1 ? 'src-eld' : 'src-est')
)

/* ── the interval and the verdict ─────────────────────────────────────────
   Both payloads carry the same interval in two layouts; lib/fuelReview
   normalizes them so this panel and the driver's cannot drift on what "plan on"
   means, and — the load-bearing part — so neither can fall back to `rangeMiles`
   when the optimistic figures come back null. They are null on an estimated
   basis ON PURPOSE. */
const interval = computed(() =>
  plan.value ? planRangeReadout(plan.value) : rangeReadout(range.value || {}),
)
const verdict = computed(() => (plan.value ? tripVerdict(plan.value.verdict) : null))
const basisBadgeClass = computed(() => {
  const b = interval.value.basisInfo
  if (!b) return ''
  return b.rank === 2 ? 'src-best' : b.rank === 1 ? 'src-est' : 'src-muted'
})
const evidenceText = computed(() =>
  interval.value.basis === 'measured'
    ? rangeEvidenceText(range.value && range.value.rangeEvidence)
    : '',
)

/* ── reading provenance + the "nothing to show" copy ──────────────────────
   The server now distinguishes a live sensor reading from one CARRIED forward
   across a dropout (see resolveFuelReading in lib/fuel-model.js). A carried
   number is an inference, so it is labelled wherever it appears — and the
   never-blank branches below exist because an empty panel was being read as
   reassurance. */
const carriedNote = computed(() => {
  const r = range.value || plan.value
  if (!r || r.fuelSource !== 'carried') return null
  const miles = r.milesSinceFuelReading
  const pct = r.fuelAnchorPct
  const bits = []
  if (pct != null) bits.push(`last reading ${Math.round(pct)}%`)
  if (miles != null) bits.push(`${milesText(miles)} mi ago`)
  return {
    text: `estimated — sensor not reporting${bits.length ? ' · ' + bits.join(', ') : ''}`,
    title:
      'The truck\'s fuel sensor is not reporting. This figure is the last credible '
      + 'reading minus the fuel burned since, so treat it as a floor, not a gauge.',
  }
})
const noFuelReason = computed(() => {
  const r = range.value
  if (!r) return 'Could not read the fuel level for this truck.'
  // 'stale' means the ELD stopped reporting entirely (a frozen fix, odometer
  // included). We deliberately do NOT carry that reading into a range — but the
  // last known value is still the most useful thing we can say, so say it.
  if (r.fuelSource === 'stale') {
    const age = r.fuelReadingAgeMinutes
    const known = r.fuelAnchorPct != null ? `Last known ${Math.round(r.fuelAnchorPct)}%` : 'No recent reading'
    return `${known}${age != null ? ', ' + agoText(age) : ''}. This truck's ELD has stopped reporting, `
      + 'so no range can be worked out — check the gauge before dispatching.'
  }
  if (r.fuelSource === 'none') {
    return "This truck's ELD has not reported a fuel level. Range cannot be estimated — check the truck's gauge."
  }
  return 'No fuel level reported by this truck’s ELD.'
})
function agoText(mins) {
  const m = Number(mins)
  if (!Number.isFinite(m)) return ''
  if (m < 90) return `${Math.round(m)} min ago`
  const h = m / 60
  if (h < 48) return `${Math.round(h)} h ago`
  return `${Math.round(h / 24)} d ago`
}
const noPlanReason = computed(() => {
  if (!props.loadId) return 'Select a load to check its route against the tank.'
  return 'No verdict yet for this load.'
})

// Collapsed-panel summary. A verdict outranks a figure, because a dispatcher
// scanning the map wants to know which truck is in trouble, not how far each
// one goes. 'clears' shows the figure rather than a green tick for the same
// reason the driver's header shows nothing on a pass — an always-on badge stops
// being read.
const headerBadge = computed(() => {
  const v = verdict.value
  if (v && (v.tone === 'bad' || v.tone === 'warn')) {
    return { tone: v.tone, text: v.chip, title: v.title }
  }
  // Collapsed, this must agree with the expanded card or the same truck reads
  // two different numbers depending on whether the panel happens to be open.
  // So it carries the USABLE figure too, and says "Refuel now" on 0 rather
  // than "0 mi" — same reasoning as the expanded readout.
  const i = interval.value
  if (i.hasReserve) {
    const b = i.basisInfo
    return {
      tone: i.mustRefuelNow ? 'warn' : 'plain',
      text: i.mustRefuelNow ? 'refuel now' : `${milesText(i.usable)} mi left`,
      title: `${milesText(i.planning)} mi to dry, holding back a ${milesText(i.reserve)} mi reserve.`
        + (b ? ` ${b.title}` : ''),
    }
  }
  if (i.known) {
    const b = i.basisInfo
    return {
      tone: 'plain',
      text: `${milesText(i.planning)} mi plan`,
      title: b ? b.title : '',
    }
  }
  return null
})

const shortfallText = computed(() => {
  const n = Number(plan.value && plan.value.shortfallMiles)
  return Number.isFinite(n) && n > 0 ? `${milesText(n)} mi` : ''
})
const refuelText = computed(() => {
  const p = plan.value
  if (!p || !p.fuelStopsRecommended) return ''
  const within = Number(p.refuelWithinMiles)
  if (!Number.isFinite(within)) return 'before the run'
  return within <= 0 ? 'now — before departure' : `within ${milesText(within)} mi`
})
const planCaveats = computed(() => {
  const p = plan.value
  if (!p) return []
  const out = []
  // Which question was answered. Planning from the pickup on a truck already
  // rolling overstates the distance left, so a dispatcher reading a big
  // shortfall needs to know it may be measured from the wrong end.
  if (p.fromLivePosition === false) {
    out.push('Measured from the load origin — no recent fix from this truck.')
  }
  if (p.routeSource === 'straight_line_estimate') {
    out.push('Road distance unavailable; estimated from straight-line distance.')
  }
  return out
})

const anyLoading = computed(() => rangeLoading.value || stopsLoading.value || planLoading.value)
const isEmpty = computed(
  () =>
    !hasFuelData.value &&
    stops.value.length === 0 &&
    !plan.value &&
    !anyLoading.value &&
    !stopsError.value,
)

function round1(n) {
  const x = Number(n)
  return Number.isFinite(x) ? Math.round(x * 10) / 10 : '—'
}
function brandDiffersFromName(s) {
  if (!s.brand || !s.name) return false
  return !s.name.toLowerCase().includes(s.brand.toLowerCase())
}

async function fetchRange() {
  if (!props.driver) {
    range.value = null
    return
  }
  rangeLoading.value = true
  try {
    const d = await api.get(`/api/fuel/range?driver=${encodeURIComponent(props.driver)}`)
    range.value = d && d.ok !== false ? d : null
  } catch {
    // 404 pre-integration or upstream error — treat as "no fuel data" so the
    // range readout simply hides.
    range.value = null
  } finally {
    rangeLoading.value = false
  }
}

// The trip verdict needs a loadId — the endpoint has no coordinate form, by
// design (it plans the REMAINING route from the truck's own live fix). With only
// the activeLoad coordinate fallback available there is nothing to ask, and the
// section stays absent rather than guessing.
async function fetchPlan() {
  plan.value = null
  planNote.value = ''
  if (!props.loadId) return
  planLoading.value = true
  try {
    const d = await api.get(`/api/fuel/trip-plan?loadId=${encodeURIComponent(props.loadId)}`)
    plan.value = d && d.ok !== false ? d : null
  } catch (e) {
    // 400 is the routine one: a load nobody has geocoded, or a truck with no
    // position to plan from. Named rather than silent — a dispatcher who sees no
    // verdict has to be able to tell "fine" from "couldn't check".
    planNote.value =
      e?.status === 400
        ? 'No verdict: this load has no mapped destination, or the truck has no position to plan from.'
        : e?.status === 429
          ? 'No verdict: too many checks just now.'
          : e?.status === 404
            ? ''
            : 'No verdict: the fuel check failed.'
  } finally {
    planLoading.value = false
  }
}

function stopsQuery() {
  if (props.loadId) return `loadId=${encodeURIComponent(props.loadId)}`
  const a = props.activeLoad
  if (a && Number.isFinite(Number(a.originLat)) && Number.isFinite(Number(a.destLat))) {
    return `originLat=${a.originLat}&originLng=${a.originLng}&destLat=${a.destLat}&destLng=${a.destLng}`
  }
  return ''
}

async function fetchStops() {
  const q = stopsQuery()
  if (!q) {
    stops.value = []
    stopsError.value = ''
    emit('stops', [])
    return
  }
  stopsLoading.value = true
  stopsError.value = ''
  try {
    const d = await api.get(`/api/poi/fuel-stops?${q}&limit=12`)
    // Backend already ranks true-cheapest first (live pump prices ascending, then
    // regional-estimate stops by distance) — preserve that order for the list.
    const list = Array.isArray(d.stops) ? d.stops : []
    stops.value = list
    livePriceCount.value = Number.isFinite(Number(d.livePriceCount))
      ? Number(d.livePriceCount)
      : list.filter((s) => s.priceSource === 'station').length
    emit('stops', list)
  } catch (e) {
    stops.value = []
    livePriceCount.value = 0
    stopsError.value =
      e?.status === 404 ? 'Truck-stop finder is not available yet.' : 'Could not load truck stops.'
    emit('stops', [])
  } finally {
    stopsLoading.value = false
  }
}

function toggleStops() {
  showStops.value = !showStops.value
  emit('show', showStops.value)
}

// Reset the map toggle whenever the focused driver/load changes so markers from
// the previous driver clear, then refetch both feeds.
function reloadAll() {
  showStops.value = false
  emit('show', false)
  emit('stops', [])
  fetchRange()
  fetchStops()
  fetchPlan()
}

watch(() => [props.driver, props.loadId], reloadAll, { immediate: true })
</script>

<style scoped>
.fuel-finder {
  position: absolute;
  bottom: 10px;
  left: 10px;
  z-index: 1000;
  width: 270px;
  max-width: calc(100% - 20px);
  background: rgba(255, 255, 255, 0.96);
  backdrop-filter: blur(8px);
  border-radius: 10px;
  box-shadow: 0 2px 12px rgba(0, 0, 0, 0.15);
  display: flex;
  flex-direction: column;
  overflow: hidden;
  font-family: 'DM Sans', sans-serif;
}

.ff-toggle {
  display: flex;
  align-items: center;
  gap: 0.4rem;
  width: 100%;
  padding: 0.55rem 0.7rem;
  background: none;
  border: none;
  font-family: inherit;
  font-size: 0.8rem;
  font-weight: 700;
  color: #0f766e;
  cursor: pointer;
}
.fuel-finder:not(.collapsed) .ff-toggle {
  border-bottom: 1px solid #eef2f2;
}
.ff-pump {
  display: inline-flex;
  align-items: center;
  justify-content: center;
  width: 20px;
  height: 20px;
  background: #0f766e;
  color: #fff;
  border-radius: 6px;
  flex-shrink: 0;
}
.ff-title-text { flex: 1 1 auto; min-width: 0; text-align: left; }
.ff-range-badge {
  font-size: 0.62rem;
  font-weight: 700;
  border-radius: 10px;
  padding: 0.05rem 0.45rem;
  white-space: nowrap;
  flex-shrink: 0;
}
.ff-range-badge.hb-plain {
  color: #065f46;
  background: #d1fae5;
}
.ff-range-badge.hb-warn {
  color: #7c2d12;
  background: #fef3c7;
  border: 1px solid #fcd34d;
}
.ff-range-badge.hb-bad {
  color: #fff;
  background: #dc2626;
  border: 1px solid #b91c1c;
}
.ff-chevron {
  font-size: 0.62rem;
  color: #94a3b8;
  transition: transform 0.2s;
  flex-shrink: 0;
}
.ff-chevron.open { transform: rotate(180deg); }

.ff-body {
  padding: 0.55rem 0.7rem 0.65rem;
  max-height: min(52vh, 420px);
  overflow-y: auto;
}

.ff-loading,
.ff-muted {
  font-size: 0.72rem;
  color: #94a3b8;
  padding: 0.35rem 0;
}
.ff-empty { text-align: center; }

/* #3 range readout with a donut ring */
.ff-range {
  display: flex;
  align-items: center;
  gap: 0.7rem;
  padding: 0.15rem 0 0.5rem;
  border-bottom: 1px dashed #e5e7eb;
  margin-bottom: 0.5rem;
}
.ff-ring {
  position: relative;
  width: 52px;
  height: 52px;
  flex-shrink: 0;
}
.ff-ring svg { width: 52px; height: 52px; transform: rotate(-90deg); }
.ff-ring-bg { fill: none; stroke: #e5e7eb; stroke-width: 3.2; }
.ff-ring-fg {
  fill: none;
  stroke: #10b981;
  stroke-width: 3.2;
  stroke-linecap: round;
  transition: stroke-dasharray 0.4s ease;
}
.ff-ring.low .ff-ring-fg { stroke: #ef4444; }
.ff-ring-label {
  position: absolute;
  inset: 0;
  display: flex;
  align-items: center;
  justify-content: center;
  font-size: 0.72rem;
  font-weight: 700;
  color: #334155;
  font-variant-numeric: tabular-nums;
}
.ff-ring.low .ff-ring-label { color: #b91c1c; }
.ff-range-info { min-width: 0; }
.ff-range-miles { display: flex; align-items: baseline; gap: 0.3rem; flex-wrap: wrap; }
.ff-range-spread {
  margin-top: 0.1rem;
  font-size: 0.66rem;
  font-weight: 600;
  color: #0f766e;
  font-variant-numeric: tabular-nums;
}
.ff-range-spread.muted { color: #94a3b8; font-weight: 500; font-style: italic; }
/* The to-dry line. Deliberately quieter than the headline and louder than the
   evidence line: it is context for the number above it, not a second answer. */
.ff-range-dry {
  margin-top: 0.1rem;
  font-size: 0.66rem;
  font-weight: 600;
  color: #b45309;
  font-variant-numeric: tabular-nums;
}
/* "Refuel now" replaces a figure, so it must not inherit the tabular-nums
   width tricks that make a number line up — it is a sentence. */
.ff-range-num.ff-now {
  font-size: 0.95rem;
  color: #b91c1c;
  font-variant-numeric: normal;
}
.ff-range-evidence {
  margin-top: 0.05rem;
  font-size: 0.62rem;
  color: #94a3b8;
  font-variant-numeric: tabular-nums;
}
/* Amber, not grey: a carried reading is a caveat the reader must actually
   notice, but not an error — the number is still the best available. */
.ff-range-carried {
  margin-top: 0.15rem;
  font-size: 0.62rem;
  font-weight: 600;
  color: #b45309;
  font-variant-numeric: tabular-nums;
}
/* The never-blank state. Deliberately styled as a real message rather than
   muted filler — this is where an empty panel used to be. */
.ff-range-none {
  margin: 0 0 0.55rem;
  padding: 0.45rem 0.55rem;
  border-radius: 8px;
  background: #fff7ed;
  border: 1px solid #fed7aa;
}
.ff-range-none-head {
  font-size: 0.72rem;
  font-weight: 700;
  color: #9a3412;
  text-transform: uppercase;
  letter-spacing: 0.03em;
}
.ff-range-none-sub {
  margin-top: 0.15rem;
  font-size: 0.66rem;
  line-height: 1.35;
  color: #7c2d12;
}

/* ---- trip verdict ---- */
.ff-plan {
  margin: 0 0 0.55rem;
  padding: 0.45rem 0.55rem 0.5rem;
  border-radius: 8px;
  border: 1px solid;
}
.ff-plan-head {
  font-size: 0.72rem;
  font-weight: 800;
  letter-spacing: 0.01em;
  margin-bottom: 0.3rem;
}
.ff-plan-rows { display: flex; flex-direction: column; gap: 0.1rem; }
.ff-plan-rows > div {
  display: flex;
  align-items: baseline;
  gap: 0.3rem;
  font-size: 0.66rem;
  color: #475569;
}
.ff-plan-rows span { min-width: 52px; color: #64748b; }
.ff-plan-rows strong {
  font-weight: 800;
  color: #0f172a;
  font-variant-numeric: tabular-nums;
}
.ff-plan-rows strong.bad { color: #b91c1c; }
.ff-plan-rows em { font-style: normal; color: #94a3b8; font-size: 0.62rem; }
.ff-plan-caveat {
  margin-top: 0.3rem;
  font-size: 0.62rem;
  line-height: 1.35;
  color: #64748b;
}
.ff-plan-old {
  margin-top: 0.35rem;
  padding-top: 0.3rem;
  border-top: 1px dashed rgba(100, 116, 139, 0.3);
  font-size: 0.6rem;
  color: #94a3b8;
  font-variant-numeric: tabular-nums;
}
.ff-plan-note { padding-bottom: 0.5rem; }

.ff-plan.v-ok { background: #f0fdf4; border-color: #bbf7d0; }
.ff-plan.v-ok .ff-plan-head { color: #166534; }
.ff-plan.v-warn { background: #fffbeb; border-color: #fde68a; }
.ff-plan.v-warn .ff-plan-head { color: #b45309; }
.ff-plan.v-bad { background: #fef2f2; border-color: #fecaca; }
.ff-plan.v-bad .ff-plan-head { color: #b91c1c; }
.ff-plan.v-unknown { background: #f8fafc; border-color: #e2e8f0; }
.ff-plan.v-unknown .ff-plan-head { color: #64748b; }
.ff-range-num {
  font-size: 1.15rem;
  font-weight: 800;
  color: #0f172a;
  font-variant-numeric: tabular-nums;
}
.ff-unit { font-size: 0.68rem; color: #94a3b8; font-weight: 600; }
.ff-range-sub {
  display: flex;
  flex-wrap: wrap;
  gap: 0.5rem;
  margin-top: 0.15rem;
  font-size: 0.68rem;
  color: #64748b;
}
.ff-mpg { display: inline-flex; align-items: center; gap: 0.25rem; }
.ff-src {
  font-size: 0.55rem;
  font-weight: 700;
  text-transform: uppercase;
  letter-spacing: 0.03em;
  padding: 0 0.28rem;
  border-radius: 4px;
}
/* Solid green outranks the outline green: 'receipts' is measured from pump
   gallons over ELD miles, with no tank sensor or tank-size guess in the path,
   so it must not read as just another non-default. */
.ff-src.src-best { background: #16a34a; color: #fff; border: 1px solid #15803d; }
.ff-src.src-eld { background: #dcfce7; color: #166534; border: 1px solid #bbf7d0; }
.ff-src.src-est { background: #f1f5f9; color: #64748b; border: 1px solid #e2e8f0; }
.ff-src.src-muted { background: #f8fafc; color: #94a3b8; border: 1px solid #e2e8f0; }

/* #2 toggle + #4 list */
.ff-stops-head {
  display: flex;
  align-items: center;
  justify-content: space-between;
  margin-bottom: 0.35rem;
}
.ff-stops-title {
  font-size: 0.68rem;
  font-weight: 700;
  text-transform: uppercase;
  letter-spacing: 0.04em;
  color: #64748b;
}
.ff-map-toggle {
  display: inline-flex;
  align-items: center;
  gap: 0.3rem;
  background: none;
  border: none;
  cursor: pointer;
  font-family: inherit;
  font-size: 0.64rem;
  font-weight: 700;
  color: #94a3b8;
  padding: 0;
}
.ff-map-toggle.on { color: #0f766e; }
.ff-switch {
  position: relative;
  width: 26px;
  height: 15px;
  border-radius: 999px;
  background: #cbd5e1;
  transition: background 0.15s;
}
.ff-map-toggle.on .ff-switch { background: #0f766e; }
.ff-knob {
  position: absolute;
  top: 2px;
  left: 2px;
  width: 11px;
  height: 11px;
  border-radius: 50%;
  background: #fff;
  transition: transform 0.15s;
}
.ff-map-toggle.on .ff-knob { transform: translateX(11px); }

.ff-price-note {
  font-size: 0.62rem;
  color: #92400e;
  background: #fffbeb;
  border: 1px solid #fde68a;
  border-radius: 6px;
  padding: 0.25rem 0.45rem;
  margin-bottom: 0.4rem;
}
.ff-price-note.live {
  color: #065f46;
  background: #ecfdf5;
  border-color: #a7f3d0;
}
.ff-cheapest {
  font-size: 0.52rem;
  font-weight: 800;
  text-transform: uppercase;
  letter-spacing: 0.03em;
  color: #166534;
  background: #dcfce7;
  border: 1px solid #bbf7d0;
  border-radius: 4px;
  padding: 0 0.28rem;
  margin-right: 0.25rem;
  vertical-align: 1px;
}

.ff-stop-list { list-style: none; margin: 0; padding: 0; }
.ff-stop {
  display: flex;
  align-items: flex-start;
  justify-content: space-between;
  gap: 0.5rem;
  width: 100%;
  text-align: left;
  background: none;
  border: none;
  border-radius: 6px;
  padding: 0.35rem 0.4rem;
  cursor: pointer;
  font-family: inherit;
  transition: background 0.12s;
}
.ff-stop:hover { background: #f0fdfa; }
.ff-stop-main { display: flex; flex-direction: column; min-width: 0; gap: 0.05rem; }
.ff-stop-name {
  font-size: 0.74rem;
  font-weight: 600;
  color: #1e293b;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}
.ff-stop-brand {
  font-size: 0.58rem;
  font-weight: 700;
  text-transform: uppercase;
  letter-spacing: 0.03em;
  color: #0f766e;
  margin-right: 0.25rem;
}
.ff-stop-addr {
  font-size: 0.64rem;
  color: #94a3b8;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}
.ff-stop-dist { font-size: 0.62rem; color: #64748b; font-weight: 600; }
.ff-stop-price {
  display: flex;
  flex-direction: column;
  align-items: flex-end;
  gap: 0.08rem;
  flex-shrink: 0;
  white-space: nowrap;
}
.ff-price-row { display: flex; align-items: baseline; gap: 0.1rem; }
.ff-price { font-size: 0.82rem; font-weight: 800; color: #64748b; font-variant-numeric: tabular-nums; }
.ff-price.live { color: #0f766e; }
.ff-price.muted { color: #cbd5e1; }
.ff-price-unit { font-size: 0.58rem; color: #94a3b8; font-weight: 600; }
.ff-price-tag {
  font-size: 0.5rem;
  font-weight: 700;
  text-transform: uppercase;
  letter-spacing: 0.03em;
  padding: 0 0.24rem;
  border-radius: 3px;
}
.tag-live { background: #dcfce7; color: #166534; border: 1px solid #bbf7d0; }
.ff-price-na { font-size: 0.62rem; color: #b0b8c4; font-weight: 600; font-style: italic; }

@media (max-width: 640px) {
  .fuel-finder { width: 220px; }
  .ff-body { max-height: 42vh; }
}
</style>
