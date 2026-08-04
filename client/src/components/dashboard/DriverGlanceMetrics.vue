<template>
  <!-- At-a-glance driver metrics shown on every panel row WITHOUT opening the
       load: absolute-time ETA + live countdown (colored on-time/delayed),
       current MPH, distance remaining, and ELD fuel %. Each field degrades to
       "—" independently so a driver missing one datum still shows the rest. -->
  <div class="glance" :aria-label="ariaSummary">
    <div class="glance-eta" :class="statusClass" :title="etaTitle">
      <svg class="glance-eta-ico" viewBox="0 0 24 24" width="11" height="11" aria-hidden="true">
        <circle cx="12" cy="12" r="9" fill="none" stroke="currentColor" stroke-width="2" />
        <path d="M12 7v5l3 2" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" />
      </svg>
      <template v-if="etaClock">
        <span class="glance-eta-time">{{ etaClock }}</span>
        <span v-if="etaDur" class="glance-eta-dur">· {{ etaDur }}</span>
      </template>
      <span v-else class="glance-eta-time muted">ETA —</span>
      <span v-if="statusLabel" class="glance-eta-flag">{{ statusLabel }}</span>
    </div>

    <div class="glance-chips">
      <span class="glance-chip" title="Current speed">
        <span class="glance-chip-v" :class="{ muted: mph == null }">{{ mph != null ? mph : '—' }}</span> mph
      </span>
      <span class="glance-chip" title="Distance remaining to destination">
        <span class="glance-chip-v" :class="{ muted: mi == null }">{{ mi != null ? mi : '—' }}</span> mi
      </span>
      <span class="glance-chip fuel" :class="{ low: fuelLow }" title="Fuel level reported by the truck's ELD">
        <span class="glance-chip-v" :class="{ muted: fuel == null }">{{ fuel != null ? fuel : '—' }}</span>% fuel
      </span>
    </div>
  </div>
</template>

<script setup>
import { computed } from 'vue'
import { formatMinutes } from '../../lib/duration'

const props = defineProps({
  speed: { type: Number, default: null },          // m/s from /api/locations/latest
  distanceMiles: { type: Number, default: null },  // remaining miles to destination
  fuelPct: { type: Number, default: null },        // 0-100 or null
  etaEpochMs: { type: Number, default: null },      // absolute arrival epoch ms (stamped at fetch)
  etaMinutes: { type: Number, default: null },      // minutes remaining (fallback for countdown)
  etaStatus: { type: String, default: 'unknown' },  // 'on-time' | 'delayed' | 'unknown'
  now: { type: Number, default: () => Date.now() }, // ticking clock for a live countdown
})

const mph = computed(() =>
  props.speed != null && Number.isFinite(props.speed) ? Math.round(props.speed * 2.23694) : null,
)
const mi = computed(() =>
  props.distanceMiles != null && Number.isFinite(props.distanceMiles) ? Math.round(props.distanceMiles) : null,
)
const fuel = computed(() =>
  props.fuelPct != null && Number.isFinite(props.fuelPct) ? Math.round(props.fuelPct) : null,
)
const fuelLow = computed(() => fuel.value != null && fuel.value <= 25)

// Absolute arrival time — "Jul 25, 3:40 PM CDT". Prefer the epoch stamped when
// the data arrived (stable) over recomputing from etaMinutes each render.
// Houston rule: pinned to America/Chicago with the zone label, never the
// viewer's zone. The label is load-bearing here — this string is read aloud to
// brokers and customers, and `.glance-eta` wraps, so it always has room.
const etaClock = computed(() => {
  if (props.etaEpochMs == null || !Number.isFinite(props.etaEpochMs)) return null
  return new Date(props.etaEpochMs).toLocaleString('en-US', {
    month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit',
    timeZone: 'America/Chicago', timeZoneName: 'short',
  })
})

// Live countdown. Counts down off the stamped epoch when present; otherwise the
// raw etaMinutes snapshot.
const remainingMin = computed(() => {
  if (props.etaEpochMs != null && Number.isFinite(props.etaEpochMs)) return (props.etaEpochMs - props.now) / 60000
  if (props.etaMinutes != null && Number.isFinite(props.etaMinutes)) return props.etaMinutes
  return null
})
const etaDur = computed(() => {
  const r = remainingMin.value
  if (r == null) return null
  if (r <= 0.5) return 'arriving'
  return `in ${formatMinutes(r)}`
})

const statusClass = computed(() => ({
  'on-time': props.etaStatus === 'on-time',
  delayed: props.etaStatus === 'delayed',
}))
// Only surface the actionable "Delayed" flag; on-time is conveyed by color.
const statusLabel = computed(() => (props.etaStatus === 'delayed' ? 'Delayed' : ''))
const etaTitle = computed(() =>
  etaClock.value
    ? `Estimated arrival ${etaClock.value}${etaDur.value ? ' (' + etaDur.value + ')' : ''}`
    : 'ETA unavailable',
)
const ariaSummary = computed(() => {
  const parts = []
  if (etaClock.value) parts.push(`ETA ${etaClock.value}${etaDur.value ? ', ' + etaDur.value : ''}`)
  if (props.etaStatus === 'delayed') parts.push('delayed')
  if (mph.value != null) parts.push(`${mph.value} miles per hour`)
  if (mi.value != null) parts.push(`${mi.value} miles remaining`)
  if (fuel.value != null) parts.push(`${fuel.value} percent fuel`)
  return parts.join('. ')
})
</script>

<style scoped>
.glance {
  display: flex;
  flex-direction: column;
  gap: 0.2rem;
  margin-top: 0.3rem;
}

.glance-eta {
  display: flex;
  align-items: center;
  flex-wrap: wrap;
  gap: 0.25rem;
  font-size: 0.66rem;
  font-weight: 600;
  color: #64748b;
  line-height: 1.2;
}
.glance-eta.on-time { color: #15803d; }
.glance-eta.delayed { color: #b91c1c; }
.glance-eta-ico { flex-shrink: 0; opacity: 0.9; }
.glance-eta-time { font-variant-numeric: tabular-nums; }
.glance-eta-time.muted { color: #b6bccb; font-weight: 500; }
.glance-eta-dur { color: #94a3b8; font-weight: 500; }
.glance-eta.on-time .glance-eta-dur { color: #16a34a; }
.glance-eta.delayed .glance-eta-dur { color: #ef4444; }
.glance-eta-flag {
  font-size: 0.55rem;
  font-weight: 700;
  text-transform: uppercase;
  letter-spacing: 0.04em;
  color: #b91c1c;
  background: #fef2f2;
  border: 1px solid #fecaca;
  border-radius: 4px;
  padding: 0 0.3rem;
}

.glance-chips {
  display: flex;
  flex-wrap: wrap;
  gap: 0.25rem;
}
.glance-chip {
  font-size: 0.6rem;
  font-weight: 500;
  color: #94a3b8;
  background: #f1f5f9;
  border: 1px solid #e2e8f0;
  border-radius: 4px;
  padding: 0.05rem 0.35rem;
  white-space: nowrap;
}
.glance-chip-v {
  font-weight: 700;
  color: #334155;
  font-variant-numeric: tabular-nums;
}
.glance-chip-v.muted { color: #cbd5e1; font-weight: 600; }
.glance-chip.fuel {
  background: #ecfdf5;
  border-color: #a7f3d0;
  color: #059669;
}
.glance-chip.fuel .glance-chip-v { color: #065f46; }
.glance-chip.fuel.low {
  background: #fef2f2;
  border-color: #fecaca;
  color: #b91c1c;
}
.glance-chip.fuel.low .glance-chip-v { color: #991b1b; }
</style>
