<template>
  <div class="route-directions">
    <div v-if="!steps || steps.length === 0" class="dir-empty">
      Turn-by-turn directions unavailable for this route.
    </div>
    <template v-else>
      <ol class="dir-list">
        <li
          v-for="(step, i) in cleanedSteps"
          :key="i"
          class="dir-step"
        >
          <div class="dir-step-icon" :title="step.maneuver">{{ iconFor(step.maneuver) }}</div>
          <div class="dir-step-body">
            <div class="dir-step-text">{{ step.instruction || `Continue` }}</div>
            <div class="dir-step-meta">{{ formatMiles(step.distanceMeters) }} mi · {{ formatMinutes(step.durationSec) }}</div>
          </div>
        </li>
      </ol>
      <div class="dir-footer">
        <a
          :href="navigateUrl"
          target="_blank"
          rel="noopener noreferrer"
          class="dir-navigate-btn"
        >
          <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">
            <polygon points="3 11 22 2 13 21 11 13 3 11" />
          </svg>
          Navigate in Maps
        </a>
        <div class="dir-handoff-hint">Opens your phone's Google Maps for voice-guided driving</div>
      </div>
    </template>
  </div>
</template>

<script setup>
import { computed } from 'vue'

const props = defineProps({
  steps: { type: Array, default: () => [] },
  destination: { type: Object, default: null }, // { lat, lng, address? }
})

// Strip HTML tags that Google's instructions sometimes include (e.g. <b>Main St</b>).
// We deliberately do NOT render the HTML — drivers don't need bold, and dropping
// it avoids any XSS surface from a third-party API.
const cleanedSteps = computed(() => {
  return (props.steps || []).map(s => ({
    ...s,
    instruction: (s.instruction || '').replace(/<[^>]*>/g, '').trim(),
  }))
})

const navigateUrl = computed(() => {
  if (!props.destination) return 'https://www.google.com/maps'
  const lat = props.destination.lat
  const lng = props.destination.lng
  // The /maps/dir/?api=1 universal scheme: opens the native Maps app on
  // iOS/Android and maps.google.com on desktop. No need for geo: or
  // comgooglemaps:// — this one URL works everywhere.
  return `https://www.google.com/maps/dir/?api=1&destination=${lat},${lng}&travelmode=driving`
})

function formatMiles(meters) {
  if (!meters) return '0'
  const mi = meters / 1609.34
  if (mi < 0.1) return '<0.1'
  return mi.toFixed(1)
}

function formatMinutes(sec) {
  if (!sec) return '<1m'
  const m = Math.round(sec / 60)
  if (m < 1) return '<1m'
  if (m < 60) return `${m}m`
  return `${Math.floor(m / 60)}h ${m % 60}m`
}

// Map Google's navigation maneuver codes to arrow glyphs. We use plain unicode
// arrows so the column lines up regardless of which icon font (or none) is
// loaded — drivers might be on a flaky cab connection.
const ICONS = {
  TURN_LEFT: '↰',
  TURN_RIGHT: '↱',
  TURN_SLIGHT_LEFT: '↖',
  TURN_SLIGHT_RIGHT: '↗',
  TURN_SHARP_LEFT: '⬅',
  TURN_SHARP_RIGHT: '➡',
  U_TURN_LEFT: '↶',
  U_TURN_RIGHT: '↷',
  STRAIGHT: '↑',
  RAMP_LEFT: '↰',
  RAMP_RIGHT: '↱',
  MERGE: '⇈',
  FORK_LEFT: '↖',
  FORK_RIGHT: '↗',
  FERRY: '⛴',
  ROUNDABOUT_LEFT: '↺',
  ROUNDABOUT_RIGHT: '↻',
  DEPART: '◉',
  NAME_CHANGE: '↑',
  DESTINATION: '📍',
}
function iconFor(maneuver) {
  return ICONS[maneuver] || '↑'
}
</script>

<style scoped>
.route-directions { width: 100%; }
.dir-empty {
  text-align: center;
  color: var(--text-dim, #6b7280);
  font-size: 0.85rem;
  padding: 1.2rem 0;
}
.dir-list {
  list-style: none;
  margin: 0;
  padding: 0;
  max-height: 320px;
  overflow-y: auto;
  -webkit-overflow-scrolling: touch;
}
.dir-step {
  display: flex;
  gap: 0.7rem;
  padding: 0.6rem 0.5rem;
  border-bottom: 1px solid #f0f1f5;
  align-items: flex-start;
}
.dir-step:last-child { border-bottom: none; }
.dir-step-icon {
  flex: 0 0 28px;
  width: 28px;
  height: 28px;
  display: flex;
  align-items: center;
  justify-content: center;
  background: #eff6ff;
  color: #2563eb;
  border-radius: 50%;
  font-size: 1.05rem;
  font-weight: 600;
}
.dir-step-body { flex: 1; min-width: 0; }
.dir-step-text {
  font-size: 0.88rem;
  color: #1f2937;
  line-height: 1.35;
}
.dir-step-meta {
  font-size: 0.72rem;
  color: #6b7280;
  margin-top: 0.15rem;
}
.dir-footer {
  margin-top: 0.6rem;
  padding-top: 0.6rem;
  border-top: 1px solid #e5e7eb;
  display: flex;
  flex-direction: column;
  align-items: stretch;
  gap: 0.3rem;
}
.dir-navigate-btn {
  display: flex;
  align-items: center;
  justify-content: center;
  gap: 0.5rem;
  background: #2563eb;
  color: #fff;
  text-decoration: none;
  font-weight: 600;
  font-size: 0.95rem;
  padding: 0.75rem 1rem;
  border-radius: 8px;
  transition: background 0.15s;
}
.dir-navigate-btn:hover { background: #1d4ed8; }
.dir-navigate-btn:active { background: #1e40af; }
.dir-handoff-hint {
  font-size: 0.72rem;
  color: #6b7280;
  text-align: center;
}
</style>
