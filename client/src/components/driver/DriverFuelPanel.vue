<template>
  <!-- Driver-app fuel panel: "how far can I get on what's in the tank" plus the
       diesel stops on this load's route, cheapest first.

       Logic is ported from the dispatcher's FuelFinderPanel; the skin is not.
       That one is a 270px map overlay at desktop density — inside a Vant
       collapse it would position itself out of flow and the type would be
       unreadable through a windshield. Here: van-cell rows for the numbers, a
       thumb-scrollable card strip for the stops, everything >= 44px. -->
  <div class="driver-fuel">
    <!-- Nothing has been asked for yet. Distinct from "we asked and there's no
         fuel sensor" — claiming the latter before the first request would be a
         lie the driver can't tell apart. -->
    <div v-if="idle" class="dfp-idle">Open this section to load fuel details.</div>

    <template v-else>
      <!-- ── 1. Does this run fit in the tank? ────────────────────────────
           First, biggest and colour-coded, because it is the only question the
           driver actually has. Everything below it is the evidence for it.

           The verdict is the SERVER's, never re-derived here. It is judged on
           the low end of the range and an unmeasured basis is derated first, so
           a 348-mile point estimate against a 346.9-mile route comes back
           `insufficient`. Comparing the numbers again on this side is exactly
           how that protection would get undone. -->
      <div v-if="planLoading" class="dfp-loading">Checking whether this run fits your fuel…</div>

      <section
        v-else-if="verdict"
        class="dfp-verdict"
        :class="'v-' + verdict.tone"
        role="status"
        aria-live="polite"
      >
        <p class="dfp-verdict-head">{{ verdict.driver }}</p>

        <p v-if="interval.known && routeText" class="dfp-verdict-line">
          <strong>{{ milesText(interval.planning) }} mi</strong> you can count on ·
          <strong>{{ routeText }} mi</strong> still to drive
        </p>
        <p v-else-if="verdictReason" class="dfp-verdict-line">{{ verdictReason }}</p>

        <!-- The instruction, not a statistic. Solid-filled so it survives
             sunlight on a windshield-mounted phone. -->
        <p v-if="actionText" class="dfp-verdict-action">{{ actionText }}</p>

        <p v-for="c in planCaveats" :key="c" class="dfp-verdict-caveat">{{ c }}</p>
      </section>

      <p v-else-if="planNote" class="dfp-plan-note">{{ planNote }}</p>

      <!-- ── 2. How far the tank goes ─────────────────────────────────── -->
      <div v-if="rangeLoading" class="dfp-loading">Reading your fuel level…</div>

      <template v-else-if="hasFuelData">
        <!-- The hero is the USABLE figure: how far you may go before you have
             to stop. It matches the dispatcher's Fuel & Route card and the
             header chip on purpose — three surfaces quoting one truck must
             agree, or a phone call between them starts with two numbers.
             Distance-to-dry is stated underneath, never hidden. A server that
             sends no reserve keeps the original "miles you can count on". -->
        <div class="dfp-hero" :class="'tone-' + heroTone">
          <template v-if="interval.hasReserve && !interval.mustRefuelNow">
            <span class="dfp-hero-num">{{ milesText(interval.usable) }}</span>
            <span class="dfp-hero-unit">miles before you need to refuel</span>
          </template>
          <!-- 0 usable miles is an instruction. "0 miles" reads as a dry tank;
               the reserve is still under the driver at that point. -->
          <template v-else-if="interval.hasReserve">
            <span class="dfp-hero-num dfp-hero-now">Refuel now</span>
            <span class="dfp-hero-unit">you are into your reserve</span>
          </template>
          <template v-else>
            <span class="dfp-hero-num">{{ interval.known ? milesText(interval.planning) : '—' }}</span>
            <span class="dfp-hero-unit">miles you can count on</span>
          </template>
        </div>
        <p v-if="interval.hasReserve" class="dfp-dry">
          That is <strong>{{ milesText(interval.planning) }} mi</strong> before the tank is dry,
          keeping <strong>{{ milesText(interval.reserve) }} mi</strong> back as a reserve.
        </p>

        <!-- The interval, drawn. Real legs at the same fuel level have run from
             the low end to the high end — a spread no single number can carry —
             so the bar shows the whole thing with the route laid over it. When
             the route marker sits past the bar, "you will not get there" is
             visible before a word is read. -->
        <div
          v-if="interval.hasSpread"
          class="dfp-bar"
          role="img"
          :aria-label="barLabel"
        >
          <div class="dfp-bar-track">
            <div class="dfp-bar-solid" :style="{ width: pctOf(interval.planning) }"></div>
            <div
              class="dfp-bar-band"
              :style="{ left: pctOf(interval.planning), width: pctSpan(interval.planning, interval.high) }"
            ></div>
            <div v-if="interval.typical != null" class="dfp-bar-tick" :style="{ left: pctOf(interval.typical) }"></div>
            <div
              v-if="routeOnBar != null"
              class="dfp-bar-route"
              :class="{ over: routeOverruns }"
              :style="{ left: pctOf(routeOnBar) }"
            ></div>
          </div>
          <!-- Read as a caption, NOT as positional labels. Spreading these
               across the track put "best 151" directly under the route marker
               at 780 mi, which invites exactly the misreading the bar exists to
               prevent. The run gets its own label on the right, coloured to
               match its marker. -->
          <div class="dfp-bar-legend">
            <span class="lg-range">
              <span class="lg-solid">count on {{ milesText(interval.planning) }}</span>
              <template v-if="interval.typical != null"> · typical {{ milesText(interval.typical) }}</template>
              · best {{ milesText(interval.high) }}
            </span>
            <span v-if="routeOnBar != null" class="lg-route" :class="{ over: routeOverruns }">
              this run {{ routeText }} mi
            </span>
          </div>
        </div>

        <!-- Same three numbers in words, for the bar's non-visual twin and for
             the estimated basis, which has no spread to draw. -->
        <p v-if="interval.hasSpread" class="dfp-spread">
          Plan on <strong>{{ milesText(interval.planning) }} mi</strong> to dry. A typical run goes about
          {{ milesText(interval.typical) }} mi; the furthest this truck has managed on this much fuel
          is {{ milesText(interval.high) }} mi.
        </p>
        <!-- NOT a dash, and NOT the old tank x mpg figure. With no fill history
             there is no spread to report, and inventing one is how "449 mi"
             reached a driver who had about 210. -->
        <p v-else-if="interval.known" class="dfp-spread muted">
          We can't give you a typical or best case for this truck yet — it hasn't recorded enough
          fill-ups. Treat {{ milesText(interval.planning) }} mi as a floor, not a forecast.
        </p>

        <p v-if="basisText" class="dfp-basis">
          <span class="dfp-src" :class="basisBadgeClass">{{ interval.basisInfo.short }}</span>
          {{ basisText }}
        </p>

        <div class="dfp-cells">
          <van-cell title="Fuel level" :value="fuelPctLabel" />
          <van-cell title="Gallons left">
            <template #value>
              <span class="dfp-val">
                <span class="dfp-val-num">{{ gallonsLabel }}</span>
                <!-- Badged ONLY when the server said where the tank size came
                     from. An older server (or the backend half of this change
                     not yet deployed) omits tankSource entirely — staying
                     silent then is the honest fallback, because labelling an
                     assumed 200 gal as measured is the exact failure this
                     badge exists to prevent. -->
                <span
                  v-if="tankSource && tankKnown"
                  class="dfp-src"
                  :class="isTruckTank ? 'src-known' : 'src-default'"
                >{{ isTruckTank ? 'from your truck' : 'fleet default' }}</span>
              </span>
            </template>
          </van-cell>
          <van-cell title="Miles per gallon">
            <template #value>
              <span class="dfp-val">
                <span class="dfp-val-num">{{ mpgLabel }}</span>
                <span v-if="mpgSrc" class="dfp-src" :class="mpgBadgeClass">
                  {{ mpgSrc.driver }}
                </span>
              </span>
            </template>
          </van-cell>
          <van-cell v-if="unitLabel" title="Truck" :value="unitLabel" />
        </div>

        <!-- Tank size multiplies the range directly: a truck whose real tank is
             100 gal, shown against the 200 gal default, reads about TWICE as
             far as it can actually go. That happened in the field, so it is
             called out ahead of the MPG note — a wrong tank is the bigger of
             the two errors by an order of magnitude. -->
        <p v-if="isDefaultTank && tankKnown" class="dfp-note">
          No tank size is on file for this truck, so this range assumes the fleet default
          of {{ tankLabel }}. If your tank is smaller than that, you have less range than
          shown — ask dispatch to record the real size.
        </p>

        <!-- A driver has to know whether the range came off their own truck or
             a fleet-wide guess before they decide to run one more hour.
             Shown ONLY for the fleet default: MPG worked out from this truck's
             own fuel receipts is the most accurate figure available, so warning
             about it would be telling a driver to distrust the best number he
             has ever been given. -->
        <p v-if="isDefaultMpg" class="dfp-note">
          There aren't enough miles or fuel receipts on this truck yet to work out its real MPG,
          so this range assumes the fleet default of {{ mpgLabel }}. Treat it as a rough estimate.
        </p>
        <p v-if="updatedLabel" class="dfp-stamp">Fuel level read {{ updatedLabel }}</p>
      </template>

      <div v-else-if="rangeError" class="dfp-error">{{ rangeError }}</div>

      <van-empty v-else :description="noFuelText" image="search" :image-size="60" />

      <!-- ── 3. Where to stop ──────────────────────────────────────────────
           When the run doesn't fit, this stops being a price list and becomes
           the answer to the question above, so it says so in its own heading —
           a driver who has scrolled past the verdict still lands on the
           instruction. -->
      <div class="dfp-section-title" :class="{ urgent: stopsRequired }">
        {{ stopsRequired ? 'Where to fuel up' : 'Diesel stops on your route' }}
      </div>
      <p v-if="stopsRequired && actionText" class="dfp-stops-lead">{{ actionText }}</p>

      <div v-if="stopsLoading" class="dfp-loading">Finding diesel stops along your route…</div>

      <div v-else-if="stopsError" class="dfp-error">{{ stopsError }}</div>

      <template v-else-if="stops.length">
        <p class="dfp-price-note" :class="{ live: livePriceCount > 0 }">
          <template v-if="livePriceCount > 0">
            Live pump prices, cheapest first. Stops without a published price show “price n/a”.
          </template>
          <template v-else>
            No pump prices are published for this route yet — these are sorted by how far
            they sit off your route.
          </template>
        </p>

        <div class="dfp-stops" role="list">
          <a
            v-for="(s, i) in stops"
            :key="s.placeId || i"
            class="dfp-stop"
            :class="{ cheapest: i === cheapestIdx }"
            role="listitem"
            :href="mapsUrl(s) || undefined"
            target="_blank"
            rel="noopener noreferrer"
            :aria-label="stopLabel(s, i)"
          >
            <span v-if="i === cheapestIdx" class="dfp-stop-badge">Cheapest</span>

            <span class="dfp-stop-price">
              <template v-if="priceOf(s) != null">
                <span class="dfp-price-amt">${{ priceOf(s) }}</span>
                <span class="dfp-price-unit">/gal</span>
              </template>
              <!-- Never interpolate a price. About a third of stops have no
                   Google coverage, and an invented number sends a driver to the
                   wrong pump. -->
              <span v-else class="dfp-price-na">price n/a</span>
            </span>
            <span v-if="dieselKind(s)" class="dfp-price-kind">{{ dieselKind(s) }}</span>
            <span v-if="priceAge(s)" class="dfp-price-age">{{ priceAge(s) }}</span>

            <span class="dfp-stop-name">
              <span v-if="s.brand && brandDiffersFromName(s)" class="dfp-stop-brand">{{ s.brand }}</span>
              {{ s.name || s.brand || 'Truck stop' }}
            </span>
            <span v-if="s.address" class="dfp-stop-addr">{{ s.address }}</span>

            <span class="dfp-stop-foot">
              <span v-if="s.aboutMilesFromRoute != null" class="dfp-stop-dist">
                ~{{ round1(s.aboutMilesFromRoute) }} mi off route
              </span>
              <span v-if="mapsUrl(s)" class="dfp-stop-go">Navigate &rsaquo;</span>
            </span>
          </a>
        </div>
      </template>

      <van-empty
        v-else
        description="No diesel stops found along this route"
        image="search"
        :image-size="60"
      />

      <!-- One explicit refresh for both feeds. Everything above is cached per
           load so opening the section again costs nothing; this is the only way
           to spend another Places lookup, and it takes a deliberate tap. -->
      <button type="button" class="dfp-refresh" :disabled="busy" @click="refresh">
        {{ busy ? 'Refreshing…' : 'Refresh fuel, stops and check' }}
      </button>
    </template>
  </div>
</template>

<script>
// ── module scope ────────────────────────────────────────────────────────────
// This block exists ONLY because `<script setup>` has no module scope: every
// top-level statement there runs inside setup(), i.e. once per instance. The
// results cache has to outlive the instance — the driver tapping Back to the
// load list unmounts LoadDetail entirely, and coming straight back into the
// same load must not re-bill the Google Places lookup.
//
// Cached per loadId, no TTL: a reopen is guaranteed free. Fresh numbers come
// from the panel's explicit Refresh button. (This is the one behaviour
// deliberately NOT ported from FuelFinderPanel, whose reloadAll() refetches on
// every prop change.)
const CACHE_MAX = 8
const fuelCache = new Map()
// key -> in-flight Promise<entry>, so a remount mid-request joins the existing
// request instead of starting a second one.
const inflight = new Map()

function cacheGet(key) {
  return fuelCache.get(key) || null
}
function cacheSet(key, entry) {
  if (fuelCache.has(key)) fuelCache.delete(key)
  fuelCache.set(key, entry)
  while (fuelCache.size > CACHE_MAX) fuelCache.delete(fuelCache.keys().next().value)
}

// The trip plan is cached SEPARATELY from the bundle above, and that separation
// is the point rather than an accident.
//
// The verdict has to reach the collapse header, i.e. before the driver opens
// anything — a warning that only appears once you go looking is not much of a
// warning, and "I didn't think about fuel" is the exact path that strands a
// truck. So the plan is fetched on mount while the expensive half stays behind
// `active`: /api/fuel/trip-plan is one route lookup the server already caches,
// whereas /api/poi/fuel-stops fans out to several BILLED Google Places calls per
// miss. Sharing one cache would mean either paying for Places on every load
// view, or writing a half-filled bundle that paints "no stops found" over stops
// nobody has looked for yet.
const planCache = new Map()
const planInflight = new Map()

function planCacheSet(key, entry) {
  if (planCache.has(key)) planCache.delete(key)
  planCache.set(key, entry)
  while (planCache.size > CACHE_MAX) planCache.delete(planCache.keys().next().value)
}
</script>

<script setup>
import { ref, computed, watch } from 'vue'
import { Cell as VanCell, Empty as VanEmpty } from 'vant'
import { useApi } from '../../composables/useApi'
import { isZoned, isYmd, fmtYmd } from '../../utils/datetime'
import {
  mpgSource,
  rangeReadout,
  planRangeReadout,
  tripVerdict,
  rangeEvidenceText,
  milesText,
} from '../../lib/fuelReview'
import { priceText, cheapestIndex, dieselLane } from '../../lib/fuelStops'

const api = useApi()

// Emitted whenever a verdict is known, so the collapse header above can badge it
// — a driver who never opens this section still has to learn they won't make it.
const emit = defineEmits(['plan'])

const props = defineProps({
  loadId: { type: String, default: '' },
  // The collapse section's open state. Nothing is fetched until this first
  // flips true — /api/poi/fuel-stops fans out to several billed Google Places
  // calls per request, so the spend has to be opt-in, and the section ships
  // collapsed by default.
  active: { type: Boolean, default: false },
  // False once the load is delivered — there is no route left to check, and a
  // verdict computed against a destination the truck already reached would be a
  // false alarm on a load in the history list. Defaults true so any caller that
  // doesn't know the status still gets the check.
  runnable: { type: Boolean, default: true },
})

const range = ref(null)
const rangeError = ref('')
const rangeLoading = ref(false)
const plan = ref(null)
const planError = ref('')
const planLoading = ref(false)
const stops = ref([])
const stopsError = ref('')
const stopsLoading = ref(false)
const livePriceCount = ref(0)
// Has a fetch ever completed for the current props? Gates the idle state.
const loaded = ref(false)

const busy = computed(() => rangeLoading.value || stopsLoading.value || planLoading.value)
const idle = computed(() => !loaded.value && !busy.value)

/* ── range readout ─────────────────────────────────────────────────────── */

const hasFuelData = computed(() => !!(range.value && range.value.hasFuelData))
const fuelLow = computed(
  () => hasFuelData.value && range.value.fuelPct != null && Number(range.value.fuelPct) <= 25,
)

/* ── the interval, and the verdict on this run ─────────────────────────────
   ONE normalizer (lib/fuelReview) reads both payloads, so the panel cannot
   drift from the dispatcher's copy on what "plan on" means — and, more to the
   point, cannot quietly fall back to `rangeMiles`. That raw tank x mpg product
   is the number that told a driver 449 miles on a tank worth about 210, and it
   is deliberately not rendered anywhere on this screen.

   The trip-plan carries its own copy of the interval, so prefer it: then the
   headline figure and the verdict are guaranteed to come from one computation
   rather than two requests that could straddle a fuel-level update. */
const interval = computed(() =>
  plan.value ? planRangeReadout(plan.value) : rangeReadout(range.value || {}),
)
const verdict = computed(() => (plan.value ? tripVerdict(plan.value.verdict) : null))

// The headline figure takes the VERDICT's colour when there is one, and falls
// back to the fuel gauge otherwise. Two independent colour rules on one card
// contradict each other in the states that matter — a green "you can make it"
// above a red range number, or an amber "too close" above one — and a driver
// then has to work out which of the two the panel means.
const heroTone = computed(() => {
  if (verdict.value) return verdict.value.tone
  return fuelLow.value ? 'bad' : 'ok'
})

const routeText = computed(() => milesText(plan.value && plan.value.routeMiles))
const stopsRequired = computed(() => !!(plan.value && plan.value.fuelStopsRecommended))

// The instruction. `refuelWithinMiles` is floored at 0 by the server, and 0 is
// not "no limit" — it means the margin is already gone, so it has to read as
// "now" rather than as "within 0 miles".
const actionText = computed(() => {
  const p = plan.value
  if (!p || !stopsRequired.value) return ''
  const within = Number(p.refuelWithinMiles)
  if (!Number.isFinite(within)) return 'Fuel up before you finish this run.'
  return within <= 0
    ? 'Fuel up now — before you start this run.'
    : `Fuel up within ${milesText(within)} mi.`
})

// Why there is no verdict, when there is a plan but nothing to judge. The
// generic caveats below are true but beside the point here — a driver whose ELD
// reports no fuel level needs to be told THAT, not that the distance was
// measured from the pickup.
const verdictReason = computed(() => {
  const p = plan.value
  if (!p || p.verdict !== 'unknown') return ''
  if (p.fuelPct == null) {
    return "Your truck isn't reporting a fuel level, so there's nothing to check this run against."
  }
  if (p.routeMiles == null) return "We don't have a distance for this run yet."
  return ''
})

// Caveats that change what the verdict MEANS, so they sit inside its card
// rather than in a footnote further down. Suppressed on an unknown verdict,
// which has its own reason above.
const planCaveats = computed(() => {
  const p = plan.value
  if (!p || p.verdict === 'unknown') return []
  const out = []
  if (p.fromLivePosition === false) {
    out.push("Measured from this load's pickup — your truck hasn't reported a recent position.")
  }
  if (p.routeSource === 'straight_line_estimate') {
    out.push('Road distance was unavailable, so this is an estimate from the straight-line distance.')
  }
  return out
})

// Why there is no verdict at all. Distinct from a verdict of "unknown": here we
// never got an answer, and saying which is missing is what stops a driver
// reading silence as "fine".
const planNote = computed(() => {
  if (plan.value || planLoading.value) return ''
  return planError.value || ''
})

/* ── the interval bar ───────────────────────────────────────────────────── */

// Scaled to whichever is further, the truck's best case or the run itself, so a
// route that overruns the range stays ON the bar and visibly past the band. The
// route marker clamps to the end rather than disappearing off it.
const barMax = computed(() => {
  const high = Number(interval.value.high) || 0
  const route = Number(plan.value && plan.value.routeMiles) || 0
  return Math.max(high, route, 1) * 1.06
})
const routeOnBar = computed(() => {
  const r = Number(plan.value && plan.value.routeMiles)
  return Number.isFinite(r) && r > 0 ? r : null
})
const routeOverruns = computed(
  () => routeOnBar.value != null && routeOnBar.value > (Number(interval.value.planning) || 0),
)
function pctOf(v) {
  const n = Number(v)
  if (!Number.isFinite(n)) return '0%'
  return `${Math.max(0, Math.min(100, (n / barMax.value) * 100))}%`
}
function pctSpan(from, to) {
  const a = Number(from)
  const b = Number(to)
  if (!Number.isFinite(a) || !Number.isFinite(b) || b <= a) return '0%'
  return `${Math.max(0, Math.min(100, ((b - a) / barMax.value) * 100))}%`
}
const barLabel = computed(() => {
  const i = interval.value
  const base = `Range you can count on ${milesText(i.planning)} miles, typically ${milesText(
    i.typical,
  )}, at best ${milesText(i.high)} miles.`
  return routeOnBar.value != null ? `${base} This run is ${routeText.value} miles.` : base
})

/* ── provenance ─────────────────────────────────────────────────────────── */

// Ranked exactly like mpgSource — measured (2) > estimated (1) > unknown (0).
const basisBadgeClass = computed(() => {
  const b = interval.value.basisInfo
  if (!b) return ''
  return b.rank === 2 ? 'src-best' : b.rank === 1 ? 'src-default' : 'src-muted'
})
const basisText = computed(() => {
  const b = interval.value.basisInfo
  if (!b || !interval.value.known) return ''
  if (b.rank === 2) {
    const ev = rangeEvidenceText(range.value && range.value.rangeEvidence)
    return ev
      ? `Measured from your own fill-ups — ${ev}.`
      : "Measured from this truck's own fill-ups."
  }
  return "A fleet-wide estimate — this truck hasn't recorded enough fill-ups to measure its own."
})
const fuelPctLabel = computed(() => {
  const p = hasFuelData.value ? Number(range.value.fuelPct) : NaN
  return Number.isFinite(p) ? `${Math.round(p)}%` : '—'
})
const gallonsLabel = computed(() => {
  if (!hasFuelData.value) return '—'
  const left = round1(range.value.gallonsRemaining)
  const tank = round1(range.value.tankGallons)
  if (left === '—') return '—'
  return tank === '—' ? `${left} gal` : `${left} / ${tank} gal`
})
const tankLabel = computed(() => {
  const t = round1(range.value && range.value.tankGallons)
  return t === '—' ? '—' : `${t} gal`
})
// 'truck' | 'default' | '' — where the tank size in `gallonsLabel` came from.
// '' means the server didn't say: either it predates tankSource or the backend
// half of this change isn't deployed yet. Anything unrecognized collapses to ''
// too, so the panel falls back to its pre-tankSource behaviour (no badge, no
// note) rather than rendering `undefined` or guessing a provenance.
const tankSource = computed(() => {
  const s = range.value && range.value.tankSource
  return s === 'truck' || s === 'default' ? s : ''
})
const isTruckTank = computed(() => tankSource.value === 'truck')
const isDefaultTank = computed(() => tankSource.value === 'default')
// A tank size we can actually name. `tankSource` on its own is not enough: the
// server can report a source while `tankGallons` comes back null, and a note
// reading "assumes the fleet default of —" is worse than no note at all. Gates
// the badge AND the note so the two can never disagree.
const tankKnown = computed(() => tankLabel.value !== '—')
// MPG provenance, ranked in lib/fuelReview: receipts (2) > eld (1) > default (0).
//
// This was a boolean — `mpgSource === 'eld'` — until receipt-derived MPG landed.
// Under the old test 'receipts' would have fallen to the else branch and been
// badged "fleet default" with a "treat it as a rough estimate" note under it,
// which is backwards: it is the only figure here measured without a tank-sensor
// reading or a tank-size assumption in the path (6.18 and 4.76 mpg on the two
// instrumented trucks, against 1.36 and 1.66 from the fuel_pct route).
//
// An unrecognised or missing value yields null → no badge, no note. Same
// convention as tankSource above; asserting a provenance we don't understand is
// worse than staying quiet.
const mpgSrc = computed(() => mpgSource(range.value && range.value.mpgSource))
const isDefaultMpg = computed(() => !!mpgSrc.value && mpgSrc.value.rank === 0)
// Receipt-derived gets its own class so it reads as BETTER than the ELD figure,
// not merely as another thing that isn't the default.
const mpgBadgeClass = computed(() =>
  !mpgSrc.value ? '' : (mpgSrc.value.rank === 2 ? 'src-best' : mpgSrc.value.rank === 1 ? 'src-known' : 'src-default')
)
const mpgLabel = computed(() => {
  const m = round1(range.value && range.value.mpg)
  return m === '—' ? '—' : `${m} mpg`
})
const unitLabel = computed(() => {
  const r = range.value
  if (!r) return ''
  const u = (r.unit || '').toString().trim()
  return u ? (/^\d+$/.test(u) ? `Unit ${u}` : u) : ''
})
const updatedLabel = computed(() => (range.value ? ago(range.value.updatedAt) : ''))
// Only say "no fuel sensor" when the server actually said so. A failed request
// gets the error branch instead — telling a driver their sensor is dead when
// the request merely timed out is worse than saying nothing.
const noFuelText = computed(() =>
  range.value
    ? "This truck's ELD isn't reporting a fuel level, so we can't estimate range."
    : 'No fuel reading available for your truck yet.',
)

/* ── stops ─────────────────────────────────────────────────────────────── */

// Both rules now live in lib/fuelStops.js, shared with the dispatcher's list and
// with the price labels on the tracking-map pins. Keyed by index rather than
// placeId so stops missing a placeId can't collide.
const cheapestIdx = computed(() => cheapestIndex(stops.value))

function priceOf(s) {
  return priceText(s)
}

function round1(n) {
  // Deliberate deviation from FuelFinderPanel's round1: it lets null through to
  // Number(), which yields 0. On the dispatcher's overlay that reads as a stray
  // zero; here it would tell a driver with a null gallonsRemaining that they
  // have "0 / 200 gal" — an empty tank — when the truth is "we don't know".
  if (n == null || n === '') return '—'
  const x = Number(n)
  return Number.isFinite(x) ? Math.round(x * 10) / 10 : '—'
}

function brandDiffersFromName(s) {
  if (!s.brand || !s.name) return false
  return !s.name.toLowerCase().includes(s.brand.toLowerCase())
}

// Truck-lane vs auto-lane diesel routinely differ by tens of cents; a driver
// pulling a 53' can't use the car island anyway, so name which one this is.
function dieselKind(s) {
  return dieselLane(s)
}

function priceAge(s) {
  if (!s || priceOf(s) == null) return ''
  const raw = s.priceAsOf || s.dieselPriceUpdated
  const rel = ago(raw)
  if (rel) return rel
  return isYmd(raw) ? `as of ${fmtYmd(raw, { fallback: '' })}` : ''
}

function mapsUrl(s) {
  const lat = Number(s && s.lat)
  const lng = Number(s && s.lng)
  if (!Number.isFinite(lat) || !Number.isFinite(lng)) return ''
  // Same universal scheme RouteDirections uses: opens the native Maps app on
  // iOS/Android, maps.google.com on desktop.
  return `https://www.google.com/maps/dir/?api=1&destination=${lat},${lng}&travelmode=driving`
}

function stopLabel(s, i) {
  const name = (s && (s.name || s.brand)) || 'Truck stop'
  const p = priceOf(s)
  const price = p != null ? `diesel $${p} per gallon` : 'no published price'
  const cheap = i === cheapestIdx.value ? ', cheapest on this route' : ''
  return `${name}, ${price}${cheap}. Navigate in Maps.`
}

// Relative age. Only for values that carry their own zone — a bare wall clock
// is viewer-dependent and would silently render a different age per timezone.
function ago(v) {
  const s = String(v || '').trim()
  if (!s || !isZoned(s)) return ''
  const t = new Date(s).getTime()
  if (!Number.isFinite(t)) return ''
  const mins = Math.round((Date.now() - t) / 60000)
  if (mins < 1) return 'just now'
  if (mins < 60) return `${mins} min ago`
  const hrs = Math.round(mins / 60)
  if (hrs < 24) return `${hrs} hr${hrs === 1 ? '' : 's'} ago`
  const days = Math.round(hrs / 24)
  return `${days} day${days === 1 ? '' : 's'} ago`
}

/* ── fetching ──────────────────────────────────────────────────────────── */

async function fetchRange() {
  try {
    // A Driver session resolves its own truck server-side — send NO params.
    const d = await api.get('/api/fuel/range')
    if (d && d.ok !== false) return { range: d, error: '' }
    return { range: null, error: '' }
  } catch (e) {
    return {
      range: null,
      error:
        e?.status === 404
          ? ''
          : "Couldn't read your fuel level. Pull down to refresh once you have signal.",
    }
  }
}

async function fetchStops(key) {
  // A Driver must query by loadId — the server rejects raw coordinates.
  if (!key) return { stops: [], livePriceCount: 0, error: '' }
  try {
    const d = await api.get(`/api/poi/fuel-stops?loadId=${encodeURIComponent(key)}&limit=12`)
    const list = Array.isArray(d.stops) ? d.stops : []
    return {
      stops: list,
      livePriceCount: Number.isFinite(Number(d.livePriceCount))
        ? Number(d.livePriceCount)
        : list.filter((s) => s.priceSource === 'station').length,
      error: '',
    }
  } catch (e) {
    return {
      stops: [],
      livePriceCount: 0,
      error:
        e?.status === 404
          ? 'Truck-stop finder is not available yet.'
          : e?.status === 429
            ? 'Too many lookups just now — try again in a few minutes.'
            : 'Could not load truck stops.',
    }
  }
}

// "Does this run fit in the tank?" — one cached Routes call plus indexed SQLite
// reads, an order of magnitude cheaper than the billed Places fan-out beside it,
// which is why it can ride along on the same open.
//
// Every failure here degrades to a SENTENCE, never to a blank space and never to
// an error banner: a driver who sees nothing where a verdict should be will read
// it as "fine". The 400s are the routine ones — a load nobody has geocoded, or a
// truck with no recent fix — and they are the caller's normal state, not a fault.
async function fetchPlan(key, { force = false } = {}) {
  if (!key || !props.runnable) return { plan: null, error: '' }
  if (!force) {
    const hit = planCache.get(key)
    if (hit) return hit
    const pending = planInflight.get(key)
    if (pending) return pending
  }
  const p = requestPlan(key)
  p.then((entry) => planCacheSet(key, entry)).catch(() => {})
  p.catch(() => {}).finally(() => {
    if (planInflight.get(key) === p) planInflight.delete(key)
  })
  planInflight.set(key, p)
  return p
}

async function requestPlan(key) {
  try {
    const d = await api.get(`/api/fuel/trip-plan?loadId=${encodeURIComponent(key)}`)
    if (d && d.ok !== false) return { plan: d, error: '' }
    return { plan: null, error: '' }
  } catch (e) {
    const status = e?.status
    if (status === 400) {
      return {
        plan: null,
        error:
          "We can't check this run yet — this load hasn't been mapped, or your truck hasn't reported its position.",
      }
    }
    if (status === 429) {
      return { plan: null, error: 'Checked too many times just now — try again in a few minutes.' }
    }
    if (status === 404) return { plan: null, error: '' }
    return { plan: null, error: "Couldn't check whether this run fits your fuel." }
  }
}

function apply(entry) {
  range.value = entry.range
  rangeError.value = entry.rangeError
  plan.value = entry.plan
  planError.value = entry.planError
  stops.value = entry.stops
  livePriceCount.value = entry.livePriceCount
  stopsError.value = entry.stopsError
  rangeLoading.value = false
  stopsLoading.value = false
  planLoading.value = false
  loaded.value = true
  emit('plan', entry.plan || null)
}

async function fetchAll(key, { force = false } = {}) {
  const [r, s, pl] = await Promise.all([fetchRange(), fetchStops(key), fetchPlan(key, { force })])
  return {
    range: r.range,
    rangeError: r.error,
    plan: pl.plan,
    planError: pl.error,
    stops: s.stops,
    livePriceCount: s.livePriceCount,
    stopsError: s.error,
  }
}

async function load({ force = false } = {}) {
  const key = props.loadId || ''
  if (!force) {
    const hit = cacheGet(key)
    // Synchronous — nothing before this line awaits, so a reopen paints the
    // cached state immediately and issues no request at all.
    if (hit) return apply(hit)
  }
  rangeLoading.value = true
  stopsLoading.value = true
  // Only spinner-over the verdict when there isn't one yet: the prefetch below
  // usually means there is, and replacing a standing "you will not make it" with
  // a spinner every time the section is opened is the one flicker that matters.
  planLoading.value = !plan.value
  rangeError.value = ''
  stopsError.value = ''
  planError.value = ''

  let p = force ? null : inflight.get(key)
  if (!p) {
    p = fetchAll(key, { force }).then((entry) => {
      cacheSet(key, entry)
      return entry
    })
    // Always release the slot, success or failure, so a failed attempt can be
    // retried from the Refresh button.
    p.catch(() => {}).finally(() => {
      if (inflight.get(key) === p) inflight.delete(key)
    })
    inflight.set(key, p)
  }

  let entry
  try {
    entry = await p
  } catch {
    // fetchRange/fetchStops/fetchPlan already swallow their own failures into
    // messages, so this only fires on something unexpected — degrade to an empty
    // panel rather than leaving the spinners up forever.
    entry = {
      range: null,
      rangeError: 'Could not load fuel details.',
      plan: null,
      planError: '',
      stops: [],
      livePriceCount: 0,
      stopsError: '',
    }
  }
  // The driver may have backed out to another load mid-flight; the result is
  // still valid for its own key (cached above) but must not land on screen.
  if ((props.loadId || '') === key) apply(entry)
}

function refresh() {
  return load({ force: true })
}

defineExpose({ refresh, load })

// Fires only once `active` is true, so the BILLED Places lookup is still opt-in.
// Re-opening re-runs this, but load() short-circuits on cache.
watch(
  () => [props.active, props.loadId],
  () => {
    if (props.active) load()
  },
  { immediate: true },
)

// The verdict, and only the verdict, is fetched without waiting for the section
// to be opened — see the planCache note above for why that is affordable and why
// the rest is not. It emits upward so the collapse header can carry the warning;
// the panel's own body is not rendered until the section opens either way.
watch(
  () => [props.loadId, props.runnable],
  async () => {
    const key = props.loadId || ''
    // Clear FIRST, and emit the clear: the parent keeps the last verdict it was
    // handed, so a load switched in place (rather than via Back, which unmounts)
    // would otherwise leave the previous load's badge sitting on this one's
    // header — a red "fuel stop needed" against the wrong run.
    if (!key || !props.runnable) {
      plan.value = null
      planError.value = ''
      emit('plan', null)
      return
    }
    const entry = await fetchPlan(key)
    // A different load may have been opened while this was in flight.
    if ((props.loadId || '') !== key) return
    // Never clobber a fuller state the section has already painted.
    if (plan.value && !entry.plan) return
    plan.value = entry.plan
    planError.value = entry.error
    planLoading.value = false
    emit('plan', entry.plan || null)
  },
  { immediate: true },
)
</script>

<style scoped>
.driver-fuel {
  padding: 0.5rem 0.25rem 0.75rem;
}

.dfp-idle,
.dfp-loading,
.dfp-error {
  font-size: 0.85rem;
  line-height: 1.4;
  color: var(--text-dim, #6b7085);
  padding: 0.75rem 0.5rem;
}
.dfp-error {
  color: #b45309;
  background: #fffbeb;
  border: 1px solid #fde68a;
  border-radius: 8px;
  margin: 0 0.25rem 0.5rem;
}

/* ---- verdict ----
   Colour is never the only channel: each tone also changes the heading wording
   and, when a stop is needed, adds the filled instruction bar. A cab is a bad
   place to depend on hue alone — sunlight, polarised glasses, and roughly one
   driver in twelve with a colour-vision deficiency. */
.dfp-verdict {
  margin: 0.25rem 0.5rem 0.85rem;
  padding: 0.8rem 0.85rem 0.85rem;
  border-radius: 12px;
  border: 2px solid;
}
.dfp-verdict-head {
  margin: 0;
  font-size: 1.12rem;
  font-weight: 800;
  line-height: 1.25;
}
.dfp-verdict-line {
  margin: 0.4rem 0 0;
  font-size: 0.9rem;
  line-height: 1.45;
}
.dfp-verdict-line strong {
  font-weight: 800;
  font-variant-numeric: tabular-nums;
}
.dfp-verdict-action {
  display: block;
  margin: 0.65rem 0 0;
  padding: 0.6rem 0.7rem;
  border-radius: 9px;
  font-size: 1rem;
  font-weight: 800;
  line-height: 1.3;
  text-align: center;
}
.dfp-verdict-caveat {
  margin: 0.45rem 0 0;
  font-size: 0.76rem;
  line-height: 1.4;
  opacity: 0.85;
}

.dfp-verdict.v-ok {
  background: #f0fdf4;
  border-color: #86efac;
  color: #14532d;
}
.dfp-verdict.v-warn {
  background: #fffbeb;
  border-color: #fbbf24;
  color: #7c2d12;
}
.dfp-verdict.v-warn .dfp-verdict-action {
  background: #b45309;
  color: #fff;
}
/* The state this whole panel exists to make unmistakable. */
.dfp-verdict.v-bad {
  background: #fef2f2;
  border-color: #dc2626;
  color: #7f1d1d;
}
.dfp-verdict.v-bad .dfp-verdict-action {
  background: #dc2626;
  color: #fff;
}
.dfp-verdict.v-unknown {
  background: var(--bg, #f5f6fa);
  border-color: var(--border, #e2e4ea);
  color: var(--text, #1f2937);
}

.dfp-plan-note {
  margin: 0.25rem 0.5rem 0.75rem;
  padding: 0.6rem 0.7rem;
  font-size: 0.82rem;
  line-height: 1.45;
  color: var(--text-dim, #6b7085);
  background: var(--bg, #f5f6fa);
  border: 1px solid var(--border, #e2e4ea);
  border-radius: 9px;
}

/* ---- range hero ---- */
.dfp-hero {
  display: flex;
  align-items: baseline;
  gap: 0.45rem;
  padding: 0.5rem 0.75rem 0.4rem;
}
.dfp-hero-num {
  font-size: 2.35rem;
  font-weight: 800;
  line-height: 1;
  color: #0f766e;
  font-variant-numeric: tabular-nums;
}
.dfp-hero.tone-warn .dfp-hero-num {
  color: #b45309;
}
.dfp-hero.tone-bad .dfp-hero-num {
  color: #dc2626;
}
.dfp-hero.tone-unknown .dfp-hero-num {
  color: var(--text-dim, #6b7085);
}
.dfp-hero-unit {
  font-size: 0.9rem;
  font-weight: 600;
  color: var(--text-dim, #6b7085);
}

/* ---- interval bar ----
   Solid = the miles to count on. Hatched = miles this truck has sometimes made
   and sometimes not. The route pin is the whole point: past the solid block it
   turns red, so "this run is beyond what I can rely on" is legible at a glance
   without reading a number. */
.dfp-bar {
  padding: 0 0.75rem;
}
.dfp-bar-track {
  position: relative;
  height: 16px;
  border-radius: 8px;
  background: var(--bg, #eef0f5);
  overflow: hidden;
}
.dfp-bar-solid {
  position: absolute;
  inset: 0 auto 0 0;
  background: #0f766e;
  border-radius: 8px 0 0 8px;
}
.dfp-bar-band {
  position: absolute;
  top: 0;
  bottom: 0;
  background: repeating-linear-gradient(
    135deg,
    rgba(15, 118, 110, 0.28),
    rgba(15, 118, 110, 0.28) 4px,
    rgba(15, 118, 110, 0.1) 4px,
    rgba(15, 118, 110, 0.1) 8px
  );
}
.dfp-bar-tick {
  position: absolute;
  top: 0;
  bottom: 0;
  width: 2px;
  background: rgba(15, 118, 110, 0.75);
}
.dfp-bar-route {
  position: absolute;
  top: -3px;
  bottom: -3px;
  width: 3px;
  margin-left: -1px;
  background: #1f2937;
  border-radius: 2px;
  box-shadow: 0 0 0 2px #fff;
}
.dfp-bar-route.over {
  background: #dc2626;
}
.dfp-bar-legend {
  display: flex;
  justify-content: space-between;
  align-items: baseline;
  flex-wrap: wrap;
  gap: 0.2rem 0.6rem;
  margin-top: 0.35rem;
  font-size: 0.7rem;
  font-weight: 700;
  color: var(--text-dim, #6b7085);
  font-variant-numeric: tabular-nums;
}
.dfp-bar-legend .lg-solid {
  color: #0f766e;
}
.dfp-bar-legend .lg-route {
  color: #1f2937;
}
.dfp-bar-legend .lg-route.over {
  color: #dc2626;
}

.dfp-spread {
  margin: 0.55rem 0.75rem 0;
  font-size: 0.84rem;
  line-height: 1.45;
  color: var(--text, #1f2937);
}
.dfp-spread strong {
  font-weight: 800;
  font-variant-numeric: tabular-nums;
}
.dfp-spread.muted {
  color: var(--text-dim, #6b7085);
}

/* The to-dry line sits directly under the hero and is the reserve made
   visible. Quieter than the hero, louder than the basis note. */
.dfp-dry {
  margin: 0.3rem 0.75rem 0;
  font-size: 0.82rem;
  line-height: 1.4;
  color: var(--text-dim, #6b7085);
}
.dfp-dry strong {
  font-weight: 800;
  color: var(--text, #1f2937);
  font-variant-numeric: tabular-nums;
}
/* "Refuel now" replaces the figure, so it drops the tabular-nums sizing that
   only makes sense for digits and shrinks to fit the phone's width. */
.dfp-hero-num.dfp-hero-now {
  font-size: 1.6rem;
  color: #b91c1c;
  font-variant-numeric: normal;
}

.dfp-basis {
  display: flex;
  align-items: center;
  gap: 0.4rem;
  flex-wrap: wrap;
  margin: 0.5rem 0.75rem 0.25rem;
  font-size: 0.78rem;
  line-height: 1.4;
  color: var(--text-dim, #6b7085);
}
.src-muted {
  background: #f1f5f9;
  color: #64748b;
  border: 1px solid #e2e8f0;
}

.dfp-cells :deep(.van-cell) {
  /* Cab-legible + thumb-sized: Vant's 14px/44px default is the floor, not the
     target, for a phone on a dash mount. */
  min-height: 48px;
  align-items: center;
  font-size: 0.92rem;
  padding-top: 0.6rem;
  padding-bottom: 0.6rem;
}

/* One value+provenance row, shared by Gallons left and Miles per gallon: both
   answer "is this figure measured or assumed?", so they get one primitive
   rather than two lookalike styles. */
.dfp-val {
  display: inline-flex;
  align-items: center;
  gap: 0.4rem;
  flex-wrap: wrap;
  justify-content: flex-end;
}
.dfp-val-num {
  font-weight: 600;
  color: var(--text, #1f2937);
}
.dfp-src {
  font-size: 0.7rem;
  font-weight: 700;
  padding: 0.1rem 0.4rem;
  border-radius: 5px;
  white-space: nowrap;
}
/* Green = this figure came off THIS truck (its ELD, or its recorded tank).
   Amber = a fleet-wide assumption stood in. Source-agnostic names because
   both cells share them. */
.src-known {
  background: #dcfce7;
  color: #166534;
  border: 1px solid #bbf7d0;
}
/* Solid green = measured from the truck's own fuel RECEIPTS: real pump gallons
   over real ELD miles, with no fuel-percentage reading and no tank-size guess
   anywhere in the path. Deliberately stronger than .src-known so it reads as
   the better number rather than as a second flavour of the same caveat. */
.src-best {
  background: #16a34a;
  color: #fff;
  border: 1px solid #15803d;
}
.src-default {
  background: #fef3c7;
  color: #92400e;
  border: 1px solid #fde68a;
}

.dfp-note {
  margin: 0.5rem 0.5rem 0;
  padding: 0.55rem 0.7rem;
  font-size: 0.8rem;
  line-height: 1.4;
  color: #92400e;
  background: #fffbeb;
  border: 1px solid #fde68a;
  border-radius: 8px;
}
.dfp-stamp {
  margin: 0.5rem 0.75rem 0;
  font-size: 0.75rem;
  color: var(--text-dim, #6b7085);
}

/* ---- stops ---- */
.dfp-section-title {
  margin: 1.1rem 0.75rem 0.5rem;
  font-size: 0.75rem;
  font-weight: 700;
  text-transform: uppercase;
  letter-spacing: 0.05em;
  color: var(--text-dim, #6b7085);
}
/* Promoted from a section label to a heading when the stop is not optional. */
.dfp-section-title.urgent {
  font-size: 0.95rem;
  text-transform: none;
  letter-spacing: 0;
  color: #b91c1c;
}
.dfp-stops-lead {
  margin: 0 0.75rem 0.5rem;
  font-size: 0.86rem;
  font-weight: 700;
  line-height: 1.4;
  color: #b91c1c;
}

.dfp-price-note {
  margin: 0 0.5rem 0.5rem;
  padding: 0.5rem 0.7rem;
  font-size: 0.78rem;
  line-height: 1.4;
  border-radius: 8px;
  color: #92400e;
  background: #fffbeb;
  border: 1px solid #fde68a;
}
.dfp-price-note.live {
  color: #065f46;
  background: #ecfdf5;
  border-color: #a7f3d0;
}

/* Thumb-scrollable strip, same idiom as RouteAlternatives. Cards are wide
   enough that the next one always peeks in, so the scroll is discoverable. */
.dfp-stops {
  display: flex;
  gap: 0.6rem;
  overflow-x: auto;
  padding: 0.6rem 0.5rem 0.6rem;
  scroll-snap-type: x mandatory;
  -webkit-overflow-scrolling: touch;
}
.dfp-stops::-webkit-scrollbar {
  height: 4px;
}
.dfp-stops::-webkit-scrollbar-thumb {
  background: rgba(0, 0, 0, 0.15);
  border-radius: 2px;
}

.dfp-stop {
  position: relative;
  display: flex;
  flex-direction: column;
  flex: 0 0 auto;
  width: 205px;
  min-height: 116px;
  gap: 0.1rem;
  padding: 0.85rem 0.8rem 0.7rem;
  background: var(--bg, #f5f6fa);
  border: 2px solid transparent;
  border-radius: 10px;
  scroll-snap-align: start;
  text-decoration: none;
  color: var(--text, #1f2937);
  transition: border-color 0.15s, background 0.15s, transform 0.05s;
}
.dfp-stop:active {
  transform: scale(0.98);
}
.dfp-stop.cheapest {
  border-color: #16a34a;
  background: #f0fdf4;
}

.dfp-stop-badge {
  position: absolute;
  top: -8px;
  left: 8px;
  padding: 0.15rem 0.42rem;
  background: #16a34a;
  color: #fff;
  border-radius: 4px;
  font-size: 0.63rem;
  font-weight: 700;
  letter-spacing: 0.02em;
  text-transform: uppercase;
}

.dfp-stop-price {
  display: flex;
  align-items: baseline;
  gap: 0.12rem;
  line-height: 1.1;
}
.dfp-price-amt {
  font-size: 1.35rem;
  font-weight: 800;
  color: #0f766e;
  font-variant-numeric: tabular-nums;
}
.dfp-price-unit {
  font-size: 0.72rem;
  font-weight: 600;
  color: var(--text-dim, #6b7085);
}
.dfp-price-na {
  font-size: 0.92rem;
  font-weight: 700;
  font-style: italic;
  color: #9ca3af;
}
.dfp-price-kind,
.dfp-price-age {
  font-size: 0.68rem;
  font-weight: 600;
  color: var(--text-dim, #6b7085);
}

.dfp-stop-name {
  margin-top: 0.3rem;
  font-size: 0.86rem;
  font-weight: 600;
  line-height: 1.25;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}
.dfp-stop-brand {
  font-size: 0.66rem;
  font-weight: 700;
  text-transform: uppercase;
  letter-spacing: 0.03em;
  color: #0f766e;
  margin-right: 0.2rem;
}
.dfp-stop-addr {
  font-size: 0.74rem;
  line-height: 1.3;
  color: var(--text-dim, #6b7085);
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}
.dfp-stop-foot {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 0.4rem;
  margin-top: auto;
  padding-top: 0.45rem;
}
.dfp-stop-dist {
  font-size: 0.72rem;
  font-weight: 600;
  color: var(--text-dim, #6b7085);
}
.dfp-stop-go {
  font-size: 0.75rem;
  font-weight: 700;
  color: #2563eb;
  white-space: nowrap;
}

/* ---- refresh ---- */
.dfp-refresh {
  display: block;
  width: calc(100% - 1rem);
  margin: 0.9rem 0.5rem 0.25rem;
  min-height: 48px;
  padding: 0.75rem 1rem;
  background: var(--surface, #fff);
  border: 1px solid var(--border, #e2e4ea);
  border-radius: 10px;
  font-family: inherit;
  font-size: 0.88rem;
  font-weight: 600;
  color: var(--text, #1f2937);
  cursor: pointer;
}
.dfp-refresh:active:not(:disabled) {
  transform: scale(0.99);
  background: var(--bg, #f5f6fa);
}
.dfp-refresh:disabled {
  opacity: 0.55;
  cursor: default;
}
</style>
