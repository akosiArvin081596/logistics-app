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
      <!-- ── Miles left in tank ─────────────────────────────────────────── -->
      <div v-if="rangeLoading" class="dfp-loading">Reading your fuel level…</div>

      <template v-else-if="hasFuelData">
        <div class="dfp-hero" :class="{ low: fuelLow }">
          <span class="dfp-hero-num">{{ rangeMilesDisplay != null ? rangeMilesDisplay : '—' }}</span>
          <span class="dfp-hero-unit">miles left in tank</span>
        </div>

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

      <!-- ── Diesel stops on this route ─────────────────────────────────── -->
      <div class="dfp-section-title">Diesel stops on your route</div>

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
        {{ busy ? 'Refreshing…' : 'Refresh fuel and stops' }}
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
</script>

<script setup>
import { ref, computed, watch } from 'vue'
import { Cell as VanCell, Empty as VanEmpty } from 'vant'
import { useApi } from '../../composables/useApi'
import { isZoned, isYmd, fmtYmd } from '../../utils/datetime'
import { mpgSource } from '../../lib/fuelReview'

const api = useApi()

const props = defineProps({
  loadId: { type: String, default: '' },
  // The collapse section's open state. Nothing is fetched until this first
  // flips true — /api/poi/fuel-stops fans out to several billed Google Places
  // calls per request, so the spend has to be opt-in, and the section ships
  // collapsed by default.
  active: { type: Boolean, default: false },
})

const range = ref(null)
const rangeError = ref('')
const rangeLoading = ref(false)
const stops = ref([])
const stopsError = ref('')
const stopsLoading = ref(false)
const livePriceCount = ref(0)
// Has a fetch ever completed for the current props? Gates the idle state.
const loaded = ref(false)

const busy = computed(() => rangeLoading.value || stopsLoading.value)
const idle = computed(() => !loaded.value && !busy.value)

/* ── range readout ─────────────────────────────────────────────────────── */

const hasFuelData = computed(() => !!(range.value && range.value.hasFuelData))
const fuelLow = computed(
  () => hasFuelData.value && range.value.fuelPct != null && Number(range.value.fuelPct) <= 25,
)
const rangeMilesDisplay = computed(() =>
  hasFuelData.value && range.value.rangeMiles != null ? Math.round(range.value.rangeMiles) : null,
)
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

// Backend returns stops already ranked (live pump prices ascending, then the
// unpriced ones by distance), so the first station-priced stop IS the cheapest.
// Keyed by index rather than placeId so stops missing a placeId can't collide.
const cheapestIdx = computed(() => stops.value.findIndex((s) => s && s.priceSource === 'station'))

function priceOf(s) {
  // Only real per-station pump prices are shown; no regional-estimate fallback.
  // Guard null/undefined explicitly — Number(null) is 0, which would render a
  // no-price station as a bogus "$0.00". Also treat 0/negative as no price.
  if (!s || s.priceSource !== 'station') return null
  const v = s.effectivePrice
  if (v == null) return null
  const p = Number(v)
  return Number.isFinite(p) && p > 0 ? p.toFixed(2) : null
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
  if (!s || priceOf(s) == null) return ''
  const t = (s.dieselType || '').toString().toUpperCase()
  if (t === 'TRUCK_DIESEL') return 'truck lane'
  if (t === 'DIESEL') return 'auto lane'
  return ''
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

function apply(entry) {
  range.value = entry.range
  rangeError.value = entry.rangeError
  stops.value = entry.stops
  livePriceCount.value = entry.livePriceCount
  stopsError.value = entry.stopsError
  rangeLoading.value = false
  stopsLoading.value = false
  loaded.value = true
}

async function fetchAll(key) {
  const [r, s] = await Promise.all([fetchRange(), fetchStops(key)])
  return {
    range: r.range,
    rangeError: r.error,
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
  rangeError.value = ''
  stopsError.value = ''

  let p = force ? null : inflight.get(key)
  if (!p) {
    p = fetchAll(key).then((entry) => {
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
    // fetchRange/fetchStops already swallow their own failures into messages,
    // so this only fires on something unexpected — degrade to an empty panel
    // rather than leaving the spinners up forever.
    entry = { range: null, rangeError: 'Could not load fuel details.', stops: [], livePriceCount: 0, stopsError: '' }
  }
  // The driver may have backed out to another load mid-flight; the result is
  // still valid for its own key (cached above) but must not land on screen.
  if ((props.loadId || '') === key) apply(entry)
}

function refresh() {
  return load({ force: true })
}

defineExpose({ refresh, load })

// Fires only once `active` is true, so nothing is requested while the section
// sits collapsed. Re-opening re-runs this, but load() short-circuits on cache.
watch(
  () => [props.active, props.loadId],
  () => {
    if (props.active) load()
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

/* ---- range hero ---- */
.dfp-hero {
  display: flex;
  align-items: baseline;
  gap: 0.45rem;
  padding: 0.5rem 0.75rem 0.75rem;
}
.dfp-hero-num {
  font-size: 2.35rem;
  font-weight: 800;
  line-height: 1;
  color: #0f766e;
  font-variant-numeric: tabular-nums;
}
.dfp-hero.low .dfp-hero-num {
  color: #dc2626;
}
.dfp-hero-unit {
  font-size: 0.9rem;
  font-weight: 600;
  color: var(--text-dim, #6b7085);
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
