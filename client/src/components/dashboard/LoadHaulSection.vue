<!--
  "Actual miles driven" — one small line under the load-detail map (dispatch
  Active and Completed), plus the planned lane for that map.

  It reads GET /api/loads/:loadId/haul once per open and does two things with
  the answer:
    - shows the ELD-measured miles for the load (`driven`), which the KPIs use;
    - emits `lane` (the planned pickup → drop-off route: geometry, distance,
      drive time) so the parent's single DriverRouteMap can draw it whenever
      the truck has no live position. The map lives in the parent; this
      component draws none. Until 2026-10 it drew a second "Full Route" map
      under the live one (PR #337); the owner asked for one map.

  ⚠️ Styles are scoped CSS, not inline style attributes. `.data-warning`,
  `.section*` and friends are scoped to FinancialsView.vue and are NOT global.
-->
<template>
  <div class="miles-section">
    <div class="miles-line" :title="lineTitle">
      <span class="miles-label">Actual miles driven:</span>
      <span v-if="loading" class="miles-muted">loading…</span>
      <span v-else-if="failed" class="miles-error">couldn't be loaded.</span>
      <span v-else-if="unavailable" class="miles-muted">{{ reasonText }}</span>
      <template v-else>
        <span class="miles-value">{{ summary }}</span>
        <span class="miles-badge" :class="basisClass" :title="basisTitle">{{ basisLabel }}</span>
      </template>
    </div>
    <div v-if="overlapText" class="miles-warn">{{ overlapText }}</div>
  </div>
</template>

<script setup>
import { ref, computed, watch } from 'vue'
import { useApi } from '../../composables/useApi'
import { milesDrivenUnavailable, milesDrivenReason, milesDrivenSummary } from '../../lib/milesDriven'

const props = defineProps({
  loadId: { type: String, default: '' },
  // The modal owns visibility. Fetching on open (rather than on mount) keeps a
  // closed modal from spending a billed Routes call per row in the table.
  open: { type: Boolean, default: false },
  // The load is still running (not delivered, completed or cancelled). Only
  // changes the wording of a missing pickup arrival (lib/milesDriven.js).
  loadInProgress: { type: Boolean, default: false },
})
// lane: { status: 'loading' | 'ready' | 'none', route, distanceMiles, etaMinutes, source }
const emit = defineEmits(['lane'])

const api = useApi()
const loading = ref(false)
const failed = ref(false)
const driven = ref(null)
let fetchSeq = 0

const unavailable = computed(() => milesDrivenUnavailable(driven.value))
const reasonText = computed(() => milesDrivenReason(driven.value, { loadInProgress: props.loadInProgress }))
const summary = computed(() => milesDrivenSummary(driven.value))

const basisLabel = computed(() => {
  const b = driven.value?.basis
  if (b === 'eld') return 'ELD'
  if (b === 'partial') return 'PARTIAL'
  return 'NO DATA'
})
const basisClass = computed(() => {
  const b = driven.value?.basis
  if (b === 'eld') return 'miles-badge-ok'
  if (b === 'partial') return 'miles-badge-warn'
  return 'miles-badge-muted'
})
const basisTitle = computed(() => {
  const b = driven.value?.basis
  if (b === 'eld') return 'Measured from the truck’s ELD odometer with no gaps or rejected readings.'
  if (b === 'partial') return 'Measured from the ELD odometer, but part of the window was missing or rejected — the figure understates the haul.'
  return 'No ELD measurement is available for this load.'
})
// The measurement is bounded by the geofence zones at each end, so it reads a
// little short against the lane; said in the line's tooltip.
const lineTitle = computed(() => {
  if (unavailable.value || driven.value?.loadedMiles == null) return ''
  const m = driven.value?.radiusM
  const mi = m ? Math.round((m / 1609.344) * 10) / 10 : 2
  return `Measured between the pickup and drop-off geofences, so it excludes roughly the first and last ${mi} mi of the haul.`
})
const overlapText = computed(() => {
  const ids = driven.value?.overlapLoadIds
  if (!Array.isArray(ids) || !ids.length) return ''
  return `This truck also ran ${ids.length === 1 ? 'load' : 'loads'} ${ids.join(', ')} during this window. ` +
    'The ELD reports odometer distance for the truck, not per load, so these miles are not split between loads.'
})

async function fetchHaul() {
  const id = (props.loadId || '').trim()
  if (!id) return
  const seq = ++fetchSeq
  loading.value = true
  failed.value = false
  driven.value = null
  emit('lane', { status: 'loading' })
  let d = null
  try {
    d = await api.get(`/api/loads/${encodeURIComponent(id)}/haul`)
  } catch {
    if (seq !== fetchSeq) return
    failed.value = true
    loading.value = false
    emit('lane', { status: 'none' })
    return
  }
  if (seq !== fetchSeq) return
  driven.value = d.driven || null
  loading.value = false
  const lane = d.lane || null
  // A lane with no geometry and no distance (an empty stored lane) is no lane:
  // the map then routes origin → drop-off itself, as it did before.
  const hasRoute = !!(lane && Array.isArray(lane.route) && lane.route.length >= 2)
  const hasDistance = !!(lane && Number(lane.distanceMiles) > 0)
  const ready = !!(lane && d.origin && d.destination && lane.source !== 'none' && (hasRoute || hasDistance))
  emit('lane', ready
    ? { status: 'ready', route: Array.isArray(lane.route) ? lane.route : null, distanceMiles: lane.distanceMiles ?? null, etaMinutes: lane.etaMinutes ?? null, source: lane.source || '' }
    : { status: 'none' })
}

watch(() => [props.loadId, props.open], ([id, open]) => {
  if (open && id) fetchHaul()
}, { immediate: true })
</script>

<style scoped>
.miles-section { margin-top: 0.5rem; }
.miles-line {
  display: flex; flex-wrap: wrap; align-items: center; gap: 0.35rem;
  font-size: 0.78rem; line-height: 1.35; color: #4b5563;
}
.miles-label { font-weight: 600; color: #374151; }
.miles-value { font-variant-numeric: tabular-nums; color: #111827; font-weight: 600; }
.miles-muted { color: #6b7280; }
.miles-error { color: #b91c1c; }
.miles-badge {
  font-size: 0.6rem; font-weight: 700; letter-spacing: 0.05em;
  padding: 1px 6px; border-radius: 4px; border: 1px solid #e5e7eb;
  background: #f3f4f6; color: #4b5563; white-space: nowrap;
}
.miles-badge-ok { background: #dcfce7; color: #166534; border-color: #bbf7d0; }
.miles-badge-warn { background: #fef3c7; color: #92400e; border-color: #fde68a; }
.miles-badge-muted { background: #f3f4f6; color: #6b7280; border-color: #e5e7eb; }
.miles-warn {
  margin-top: 0.35rem; font-size: 0.72rem; line-height: 1.35;
  background: #fffbeb; border: 1px solid #fde68a; color: #92400e;
  border-radius: 6px; padding: 0.35rem 0.5rem;
}
</style>
