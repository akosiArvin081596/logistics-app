<!--
  StatusTimeline — per-phase load status history with start / end / duration.
  Self-fetches GET /api/loads/:loadId/status-history (server computes the phases).
  Framework-neutral (own scoped CSS, no shadcn/Vant) so it renders identically in
  the admin dashboard modals and the Vant-based driver app. Forward-only: loads
  with no recorded transitions show a friendly empty state.
-->
<template>
  <div class="status-timeline" :class="{ compact }">
    <div v-if="loading" class="st-msg">Loading timeline…</div>
    <div v-else-if="error" class="st-msg">Couldn’t load status history.</div>
    <div v-else-if="!phases.length" class="st-msg st-empty">
      No status history recorded yet. The timeline begins tracking at this load’s next status update.
    </div>
    <ol v-else class="st-list">
      <li v-for="(p, i) in rows" :key="i" class="st-item" :class="{ current: p.inProgress }">
        <span class="st-rail"><span class="st-dot" :style="{ background: colorsFor(p.status).fg }"></span></span>
        <div class="st-body">
          <div class="st-row1">
            <span class="st-pill" :style="pillStyle(p.status)">{{ p.status }}</span>
            <span v-if="p.inProgress" class="st-live">In progress</span>
            <span v-else-if="p.durationMs != null" class="st-dur">{{ humanizeDuration(p.durationMs) }}</span>
          </div>
          <div class="st-times">
            <span>Started {{ fmt(p.startedAt) }}</span>
            <span v-if="p.endedAt"> · Ended {{ fmt(p.endedAt) }}</span>
          </div>
          <!-- Secondary, viewer-zone echo. The app-zone time above stays the
               value of record; this is only an orientation aid and renders for
               nobody whose browser is in the app zone (both notes are '' there,
               so the whole line disappears). -->
          <div v-if="p.startedNote || p.endedNote" class="st-viewer-tz">
            <span v-if="p.startedNote">Started {{ p.startedNote }}</span>
            <span v-if="p.endedNote"> · Ended {{ p.endedNote }}</span>
          </div>
          <!-- `reason` carries how far the truck was from the MAPPED point when a
               GPS transition fired. A geocode lands on a gate or centroid, not the
               dock, so at a large site the truck can legitimately be a few hundred
               metres out — showing the number is what makes the auto-status
               auditable instead of something you have to take on faith. -->
          <div v-if="p.source && p.source !== 'manual'" class="st-src">
            via {{ sourceLabel(p.source) }}<span v-if="p.reason"> · {{ p.reason }}</span>
          </div>
        </div>
      </li>
    </ol>
  </div>
</template>

<script setup>
import { computed, ref, watch } from 'vue'
import { useApi } from '@/composables/useApi'
import { fmtTimestamp, viewerZoneNote } from '@/utils/datetime'

const props = defineProps({
  // When provided (non-null), phases are rendered directly and no fetch happens —
  // lets the unauthenticated public tracker pass pre-fetched phases since it can't
  // call the protected status-history endpoint. Null = self-fetch by loadId.
  phases: { type: Array, default: null },
  loadId: { type: String, default: '' },
  autoLoad: { type: Boolean, default: true },
  compact: { type: Boolean, default: false },
})

const api = useApi()
const phases = ref([])
const loading = ref(false)
const error = ref(false)

async function load() {
  if (!props.loadId) { phases.value = []; return }
  loading.value = true
  error.value = false
  try {
    const r = await api.get(`/api/loads/${encodeURIComponent(props.loadId)}/status-history`)
    phases.value = Array.isArray(r.phases) ? r.phases : []
  } catch {
    error.value = true
    phases.value = []
  } finally {
    loading.value = false
  }
}
// Pre-fetched phases passed in: render them, never fetch.
watch(() => props.phases, (v) => {
  if (v != null) { phases.value = v; loading.value = false; error.value = false }
}, { immediate: true })
// Self-fetch only when no phases prop is supplied.
watch(() => props.loadId, () => { if (props.phases == null && props.autoLoad) load() }, { immediate: true })
defineExpose({ reload: load })

// Status → colors, mirroring StatusBadge.vue's palette.
const PALETTE = [
  [/in.?transit/, '#1d4ed8', '#dbeafe'],
  [/dispatched|assigned/, '#4338ca', '#e0e7ff'],
  [/delivered|completed|pod.?received/, '#047857', '#d1fae5'],
  [/at.?shipper|loading/, '#b45309', '#fef3c7'],
  [/at.?receiver|unloading/, '#c2410c', '#ffedd5'],
  [/cancel/, '#b91c1c', '#fee2e2'],
]
function colorsFor(status) {
  const s = (status || '').trim().toLowerCase()
  for (const [re, fg, bg] of PALETTE) if (re.test(s)) return { fg, bg }
  return { fg: '#4b5563', bg: '#f3f4f6' }
}
function pillStyle(status) {
  const c = colorsFor(status)
  return { color: c.fg, background: c.bg }
}

// The app zone (APP_TIMEZONE, US Eastern), always, with its label ("Aug 4,
// 2026, 9:05 AM EDT") — never the viewer's.
//
// These values ARE true instants (the endpoint serves
// strftime('%Y-%m-%dT%H:%M:%SZ', changed_at)), so CONVERTING is correct; what was
// wrong is converting to the VIEWER. On the default zone a load stamped 8:05 AM
// CDT rendered "Aug 4, 9:05 PM GMT+8" for the Manila dev while the row beside it
// showed the business clock — same load, two clocks, permanently, on every new
// load. The year is shown, so a Jun 30 <-> Jul 1 crossing says which year it is.
const fmt = (iso) => fmtTimestamp(iso, { fallback: '' })
// Secondary line: the same instant in the VIEWER's own zone, shown only when the
// browser is not set to the app zone (viewerZoneNote, keyed on the browser zone
// because the owner and the Manila developer share one super_admin login).
//
// Safe HERE specifically because these values are true ISO-Z instants from
// load_status_history, so a real equivalent in another zone exists. Do NOT copy
// this onto a bare sheet wall clock — those carry no instant, and an "equivalent"
// would be a guess about which zone the text was typed in.
//
// Decorated onto each phase once, rather than calling viewerZoneNote() four
// times per row straight from the template (v-if + both spans).
const rows = computed(() => phases.value.map((p) => ({
  ...p,
  startedNote: viewerZoneNote(p.startedAt),
  endedNote: p.endedAt ? viewerZoneNote(p.endedAt) : '',
})))
function humanizeDuration(ms) {
  if (ms == null || ms < 0) return ''
  const m = Math.floor(ms / 60000)
  if (m < 1) return '<1m'
  const d = Math.floor(m / 1440), h = Math.floor((m % 1440) / 60), mm = m % 60
  if (d) return `${d}d ${h}h`
  if (h) return `${h}h ${mm}m`
  return `${mm}m`
}
const SOURCE_LABELS = {
  geofence: 'GPS arrival', override: 'admin override', dispatch: 'dispatch',
  accept: 'driver accept', decline: 'driver decline', cancel: 'cancellation',
}
function sourceLabel(s) { return SOURCE_LABELS[s] || s }
</script>

<style scoped>
.status-timeline { font-size: 0.85rem; }
.st-msg { color: #6b7280; padding: 0.4rem 0; }
.st-empty { font-style: italic; }
.st-list { list-style: none; margin: 0; padding: 0; }
.st-item { position: relative; display: flex; gap: 0.6rem; padding-bottom: 0.9rem; }
.st-item:last-child { padding-bottom: 0; }
.st-rail { position: relative; display: flex; flex-direction: column; align-items: center; }
.st-dot {
  width: 11px; height: 11px; border-radius: 50%; margin-top: 3px; flex: none;
  box-shadow: 0 0 0 2px #fff; z-index: 1;
}
.st-item:not(:last-child) .st-rail::after {
  content: ''; position: absolute; top: 16px; bottom: -4px; width: 2px; background: #e5e7eb;
}
.st-body { flex: 1; min-width: 0; }
.st-row1 { display: flex; align-items: center; gap: 0.5rem; flex-wrap: wrap; }
.st-pill { display: inline-block; padding: 1px 8px; border-radius: 999px; font-size: 0.72rem; font-weight: 600; }
.st-dur { color: #6b7280; font-size: 0.75rem; font-weight: 600; }
.st-live { color: #047857; background: #d1fae5; padding: 1px 8px; border-radius: 999px; font-size: 0.7rem; font-weight: 600; }
.st-times { color: #6b7280; font-size: 0.78rem; margin-top: 2px; }
/* Clearly subordinate to .st-times above — lighter and smaller, so the app-zone
   time reads as the value of record and this as the aside it is. */
.st-viewer-tz { color: #9ca3af; font-size: 0.72rem; margin-top: 1px; }
.st-src { color: #9ca3af; font-size: 0.72rem; margin-top: 1px; }
.st-item.current .st-pill { box-shadow: 0 0 0 2px rgba(4, 120, 87, 0.15); }
.compact { font-size: 0.8rem; }
.compact .st-item { padding-bottom: 0.7rem; }
.compact .st-times { font-size: 0.74rem; }
.compact .st-viewer-tz { font-size: 0.7rem; }
</style>
