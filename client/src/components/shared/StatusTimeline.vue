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
      <li v-for="(p, i) in phases" :key="i" class="st-item" :class="{ current: p.inProgress }">
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
          <div v-if="p.source && p.source !== 'manual'" class="st-src">via {{ sourceLabel(p.source) }}</div>
        </div>
      </li>
    </ol>
  </div>
</template>

<script setup>
import { ref, watch } from 'vue'
import { useApi } from '@/composables/useApi'

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

function fmt(iso) {
  if (!iso) return ''
  try {
    return new Intl.DateTimeFormat(undefined, {
      month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit', timeZoneName: 'short',
    }).format(new Date(iso))
  } catch { return iso }
}
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
.st-src { color: #9ca3af; font-size: 0.72rem; margin-top: 1px; }
.st-item.current .st-pill { box-shadow: 0 0 0 2px rgba(4, 120, 87, 0.15); }
.compact { font-size: 0.8rem; }
.compact .st-item { padding-bottom: 0.7rem; }
.compact .st-times { font-size: 0.74rem; }
</style>
