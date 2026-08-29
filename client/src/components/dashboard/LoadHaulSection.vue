<!--
  Full Route — Pickup -> Drop-off.

  The section Deshorn asked for (2026-08-28), sitting UNDER the Route Map in the
  dispatch load-detail modal. It deliberately does NOT replace anything above it:
  DriverRouteMap is phase-scoped and its chips describe the CURRENT LEG
  (truck->pickup before collection, truck->drop-off after). This one describes
  the whole haul and never counts down.

  ⚠️ WHY THIS IS ITS OWN COMPONENT rather than a second <DriverRouteMap>.
  That component hides the pickup marker once the load is picked up
  (`originLatLng && hasCoords && !pickedUp`) and anchors its polyline to the
  truck pin, trimming everything already driven. Both are correct for a live leg
  and both are wrong for a lane. It also carries deviation detection, Drive Mode,
  voice guidance and the matched-offset countdown, none of which mean anything
  here — and it is shared by six surfaces, so widening it to serve a second
  purpose would put the driver app and the public tracker at risk for no gain.

  ⚠️ Styles are scoped CSS, not inline style attributes. `.data-warning`,
  `.section*` and friends are scoped to FinancialsView.vue and are NOT global —
  assuming otherwise has already shipped unstyled text twice.
-->
<template>
  <div class="haul-section">
    <div class="dash-section-title haul-title">
      <span>Full Route — Pickup → Drop-off</span>
      <span v-if="lane && lane.source === 'straight_line'" class="haul-badge haul-badge-warn"
            title="Google could not route this lane, so the distance is a straight line between the two points — the real road distance will be higher.">
        STRAIGHT LINE
      </span>
      <span v-else-if="lane && lane.source === 'stored'" class="haul-badge haul-badge-muted"
            title="Road distance measured earlier and stored; the route line could not be redrawn just now.">
        STORED
      </span>
    </div>

    <div v-if="loading" class="haul-state">Loading the full route…</div>
    <div v-else-if="error" class="haul-state haul-state-error">{{ error }}</div>
    <div v-else-if="!hasLane" class="haul-state">
      No pickup/drop-off coordinates for this load, so the full route cannot be drawn.
    </div>

    <template v-else>
      <div class="haul-chips">
        <span v-if="lane.distanceMiles != null" class="haul-chip haul-chip-strong">
          {{ fmtMiles(lane.distanceMiles) }} mi total
        </span>
        <span v-if="lane.etaMinutes != null" class="haul-chip">
          {{ fmtMinutes(lane.etaMinutes) }} drive time
        </span>
      </div>

      <div v-if="endpointLabel" class="haul-lane-label">{{ endpointLabel }}</div>

      <div ref="mapEl" class="haul-map"></div>

      <!-- ── Miles actually driven ────────────────────────────────────────── -->
      <div class="haul-driven">
        <div class="haul-driven-head">
          <span>Actual miles driven</span>
          <span class="haul-badge" :class="basisClass" :title="basisTitle">{{ basisLabel }}</span>
        </div>

        <div v-if="drivenUnavailable" class="haul-note">{{ reasonText }}</div>

        <table v-else class="haul-table">
          <tbody>
            <tr>
              <th>Loaded <span class="haul-sub">pickup → drop-off</span></th>
              <td>{{ milesCell(driven.loadedMiles) }}<span v-if="driven.inProgress" class="haul-sub"> so far</span></td>
            </tr>
            <tr>
              <th>Deadhead <span class="haul-sub">dispatch → pickup</span></th>
              <td>{{ milesCell(driven.deadheadMiles) }}</td>
            </tr>
            <tr class="haul-total">
              <th>Total for this load</th>
              <td>{{ milesCell(driven.totalMiles) }}</td>
            </tr>
            <tr v-if="vsLane !== null">
              <th>Loaded vs planned lane</th>
              <td>{{ vsLane >= 0 ? '+' : '' }}{{ fmtMiles(vsLane) }} mi</td>
            </tr>
          </tbody>
        </table>

        <!-- The measurement is bounded by 2-mile zones at each end, so it reads
             a little short against the lane. Said out loud rather than left for
             someone to discover as a discrepancy. -->
        <div v-if="!drivenUnavailable && driven.loadedMiles != null" class="haul-note haul-note-quiet">
          Measured between the pickup and drop-off geofences, so it excludes roughly
          the first and last {{ radiusMiles }} mi of the haul.
        </div>

        <div v-if="driven.overlapLoadIds && driven.overlapLoadIds.length" class="haul-warn">
          ⚠ This truck also ran
          {{ driven.overlapLoadIds.length === 1 ? 'load' : 'loads' }}
          {{ driven.overlapLoadIds.join(', ') }}
          during this window. The ELD reports odometer distance for the truck, not per load,
          so these miles are the truck's for the period — they are not split between loads.
        </div>
      </div>
    </template>
  </div>
</template>

<script setup>
import { ref, computed, watch, onBeforeUnmount, nextTick } from 'vue'
import { useApi } from '../../composables/useApi'
import { useGoogleMaps, createDotPin } from '../../composables/useGoogleMaps'
import { formatMinutes } from '../../lib/duration'

const props = defineProps({
  loadId: { type: String, default: '' },
  // The modal owns visibility. Fetching on open (rather than on mount) keeps a
  // closed modal from spending a billed Routes call per row in the table.
  open: { type: Boolean, default: false },
})

const api = useApi()
const { createMap, load: loadMaps } = useGoogleMaps()

const loading = ref(false)
const error = ref('')
const lane = ref(null)
const driven = ref(null)
const origin = ref(null)
const destination = ref(null)
const mapEl = ref(null)

let map = null
let markers = []
let line = null

const hasLane = computed(() => !!(origin.value && destination.value))
const drivenUnavailable = computed(() =>
  !driven.value || driven.value.basis === 'no-data' ||
  (driven.value.loadedMiles == null && driven.value.deadheadMiles == null))

const basisLabel = computed(() => {
  const b = driven.value?.basis
  if (b === 'eld') return 'ELD'
  if (b === 'partial') return 'PARTIAL'
  return 'NO DATA'
})
const basisClass = computed(() => {
  const b = driven.value?.basis
  if (b === 'eld') return 'haul-badge-ok'
  if (b === 'partial') return 'haul-badge-warn'
  return 'haul-badge-muted'
})
const basisTitle = computed(() => {
  const b = driven.value?.basis
  if (b === 'eld') return 'Measured from the truck’s ELD odometer with no gaps or rejected readings.'
  if (b === 'partial') return 'Measured from the ELD odometer, but part of the window was missing or rejected — the figure understates the haul.'
  return 'No ELD measurement is available for this load.'
})

// ⚠️ Every one of these is an ABSENCE, not a zero. The endpoint returns null
// miles with a reason precisely so this component never prints "0 mi" for a
// haul nobody measured.
const REASONS = {
  disabled: 'ELD mileage measurement is currently turned off.',
  no_coordinates: 'This load has no mapped pickup or drop-off, so the haul cannot be measured.',
  no_truck_assigned: 'No truck is assigned to this load yet.',
  load_not_on_sheet: 'This load is no longer on the Job Tracking sheet, so its truck cannot be identified.',
  no_eld_device: 'This truck has no ELD device linked, so its miles are not reported.',
  no_samples: 'No telemetry is retained for this period (the feed keeps 90 days).',
  no_pickup_zone: 'The truck was never recorded at the pickup, so the haul cannot be measured.',
  no_departure: 'The truck has not left the pickup yet.',
  no_arrival: 'The truck was never recorded arriving at the drop-off.',
}
const reasonText = computed(() =>
  REASONS[driven.value?.reason] || 'No ELD measurement is available for this load.')

const radiusMiles = computed(() => {
  const m = driven.value?.radiusM
  return m ? Math.round((m / 1609.344) * 10) / 10 : 2
})

const vsLane = computed(() => {
  const a = driven.value?.loadedMiles
  const b = lane.value?.distanceMiles
  if (a == null || b == null || driven.value?.inProgress) return null
  return Math.round((a - b) * 10) / 10
})

const endpointLabel = computed(() => {
  const a = shortAddr(origin.value?.address)
  const b = shortAddr(destination.value?.address)
  if (!a && !b) return ''
  return `${a || 'Pickup'}  →  ${b || 'Drop-off'}`
})

// Last two comma-separated parts — "Houston, TX 77002" out of a full street
// address. Deliberately drops the street: this is a lane label, and the modal
// already shows the full addresses above.
function shortAddr(s) {
  if (!s) return ''
  const parts = String(s).split(',').map(p => p.trim()).filter(Boolean)
  if (parts.length <= 1) return parts[0] || ''
  return parts.slice(-2).join(', ')
}
function fmtMiles(n) {
  if (n == null) return '—'
  return (Math.round(n * 10) / 10).toLocaleString(undefined, { maximumFractionDigits: 1 })
}
function fmtMinutes(m) { return formatMinutes(m) || '—' }
function milesCell(n) { return n == null ? '—' : `${fmtMiles(n)} mi` }

async function fetchHaul() {
  const id = (props.loadId || '').trim()
  if (!id) return
  loading.value = true
  error.value = ''
  lane.value = null; driven.value = null; origin.value = null; destination.value = null
  try {
    const d = await api.get(`/api/loads/${encodeURIComponent(id)}/haul`)
    lane.value = d.lane || null
    driven.value = d.driven || null
    origin.value = d.origin || null
    destination.value = d.destination || null
  } catch (e) {
    error.value = 'Could not load the full route.'
  } finally {
    loading.value = false
  }
  if (hasLane.value) { await nextTick(); renderMap() }
}

async function renderMap() {
  if (!mapEl.value || !origin.value || !destination.value) return
  try {
    const maps = await loadMaps()
    if (!map) map = await createMap(mapEl.value, { zoom: 6 })
    clearOverlays()

    const o = { lat: origin.value.lat, lng: origin.value.lng }
    const d = { lat: destination.value.lat, lng: destination.value.lng }

    markers.push(new maps.marker.AdvancedMarkerElement({
      position: o, map, content: createDotPin('#16a34a', 14), title: 'Pickup',
    }))
    markers.push(new maps.marker.AdvancedMarkerElement({
      position: d, map, content: createDotPin('#dc2626', 14), title: 'Drop-off',
    }))

    const pts = Array.isArray(lane.value?.route) && lane.value.route.length >= 2
      ? lane.value.route.map(p => ({ lat: p.latitude, lng: p.longitude }))
      : [o, d]
    // A straight two-point fallback is drawn DASHED so it never passes for a
    // real road route on a glance.
    const isRealRoute = pts.length > 2
    line = new maps.Polyline({
      path: pts,
      map,
      strokeColor: '#2563eb',
      strokeOpacity: isRealRoute ? 0.9 : 0,
      strokeWeight: 4,
      icons: isRealRoute ? undefined : [{
        icon: { path: 'M 0,-1 0,1', strokeOpacity: 0.7, strokeColor: '#64748b', scale: 3 },
        offset: '0', repeat: '12px',
      }],
    })

    const bounds = new maps.LatLngBounds()
    pts.forEach(p => bounds.extend(p))
    map.fitBounds(bounds, 40)
  } catch { /* the figures above still stand without a map */ }
}

function clearOverlays() {
  markers.forEach(m => { m.map = null })
  markers = []
  if (line) { line.setMap(null); line = null }
}

watch(() => [props.loadId, props.open], ([id, open]) => {
  if (open && id) fetchHaul()
}, { immediate: true })

onBeforeUnmount(() => { clearOverlays(); map = null })
</script>

<style scoped>
.haul-section { margin-top: 1rem; }
.haul-title { display: flex; align-items: center; gap: 0.5rem; }

.haul-badge {
  font-size: 0.6rem; font-weight: 700; letter-spacing: 0.05em;
  padding: 1px 6px; border-radius: 4px; border: 1px solid #e5e7eb;
  background: #f3f4f6; color: #4b5563; white-space: nowrap;
}
.haul-badge-ok { background: #dcfce7; color: #166534; border-color: #bbf7d0; }
.haul-badge-warn { background: #fef3c7; color: #92400e; border-color: #fde68a; }
.haul-badge-muted { background: #f3f4f6; color: #6b7280; border-color: #e5e7eb; }

.haul-state { font-size: 0.8rem; color: #6b7280; padding: 0.75rem 0; }
.haul-state-error { color: #b91c1c; }

.haul-chips { display: flex; flex-wrap: wrap; align-items: center; gap: 0.4rem; margin-bottom: 0.35rem; }
.haul-chip {
  font-size: 0.75rem; font-weight: 600; color: #374151;
  background: #f3f4f6; border: 1px solid #e5e7eb; border-radius: 6px; padding: 2px 8px;
}
.haul-chip-strong { background: #eff6ff; color: #1d4ed8; border-color: #bfdbfe; }

.haul-lane-label { font-size: 0.75rem; color: #6b7280; margin-bottom: 0.5rem; }

.haul-map { width: 100%; height: 240px; border-radius: 8px; overflow: hidden; background: #f3f4f6; }

.haul-driven { margin-top: 0.75rem; border: 1px solid #f3f4f6; border-radius: 8px; padding: 0.6rem 0.75rem; }
.haul-driven-head {
  display: flex; align-items: center; gap: 0.5rem;
  font-size: 0.7rem; font-weight: 700; letter-spacing: 0.04em;
  text-transform: uppercase; color: #6b7280; margin-bottom: 0.4rem;
}

.haul-table { width: 100%; border-collapse: collapse; font-size: 0.8rem; }
.haul-table th {
  text-align: left; font-weight: 500; color: #4b5563; padding: 3px 0;
}
.haul-table td {
  text-align: right; font-variant-numeric: tabular-nums; color: #111827; padding: 3px 0;
}
.haul-total th, .haul-total td {
  border-top: 1px solid #e5e7eb; padding-top: 6px; font-weight: 700; color: #111827;
}
.haul-sub { color: #9ca3af; font-weight: 400; }

.haul-note { font-size: 0.75rem; color: #6b7280; }
.haul-note-quiet { margin-top: 0.4rem; font-size: 0.7rem; color: #9ca3af; }

.haul-warn {
  margin-top: 0.5rem; font-size: 0.72rem; line-height: 1.35;
  background: #fffbeb; border: 1px solid #fde68a; color: #92400e;
  border-radius: 6px; padding: 0.45rem 0.55rem;
}
</style>
