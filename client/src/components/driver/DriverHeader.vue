<template>
  <header class="app-header">
    <div class="app-header-left">
      <img src="/logo.png" alt="LogisX" class="header-logo" />
      <span class="driver-name-label">{{ driverName }}</span>
      <span
        v-if="socketConnected === false && hasEverConnected"
        class="status-chip warn"
        title="Real-time connection lost — trying to reconnect"
      >&#9888; Offline</span>
      <span
        v-else-if="gpsStatus === 'failing'"
        class="status-chip warn"
        title="Location not syncing to dispatch"
      >&#128205; GPS sync</span>
      <!-- Fuel range, on every driver screen.
           The client's ask after the 2026-08-17 run-dry was that range be
           "displayed throughout even when they park even when they're idling".
           The detailed panel lives behind a tap inside one load's detail screen,
           and a driver who runs dry is by definition one who never opened it —
           so the number has to sit somewhere they cannot miss. This is that
           somewhere. It is driver-scoped server-side (no params), so it costs
           one indexed read and cannot leak another truck's state. -->
      <span
        v-if="fuelChip"
        class="status-chip fuel-chip"
        :class="fuelChip.tone"
        :title="fuelChip.title"
      >&#9981; {{ fuelChip.text }}</span>
    </div>
    <div class="app-header-right">
      <button class="header-btn" title="Change password" @click="showPwModal = true">Password</button>
      <button class="header-btn danger" @click="$emit('logout')">Logout</button>
    </div>
    <ChangePasswordModal :open="showPwModal" @close="showPwModal = false" />
  </header>
</template>

<script setup>
import { ref, computed, onMounted, onBeforeUnmount } from 'vue'
import ChangePasswordModal from './ChangePasswordModal.vue'
import { useApi } from '../../composables/useApi'

defineProps({
  driverName: { type: String, default: '' },
  gpsStatus: { type: String, default: 'ok' },
  socketConnected: { type: Boolean, default: true },
  hasEverConnected: { type: Boolean, default: false },
})

defineEmits(['logout'])

const showPwModal = ref(false)

/* ── persistent fuel range ────────────────────────────────────────────────
   A Driver session resolves its own truck server-side, so this sends NO
   params — see the scoping note on GET /api/fuel/range. Polled slowly: the
   endpoint is local SQLite only (no Google/Places call), and fuel does not
   move fast enough to justify anything tighter. */
const api = useApi()
const range = ref(null)
let timer = null

async function loadRange() {
  try {
    const d = await api.get('/api/fuel/range')
    range.value = d && d.ok !== false ? d : null
  } catch {
    // A failed fetch must not invent a fuel state — leave the last known value
    // (or nothing) rather than rendering a reassuring dash.
  }
}
onMounted(() => {
  loadRange()
  timer = setInterval(loadRange, 120000)
})
onBeforeUnmount(() => { if (timer) clearInterval(timer) })

const fuelChip = computed(() => {
  const r = range.value
  if (!r) return null
  // No usable reading — say so rather than showing a comforting blank. 'stale'
  // means the ELD stopped reporting entirely; we deliberately publish no number
  // for it (a dead device's last reading is not a range).
  if (!r.hasFuelData || r.rangePlanningMiles == null) {
    const known = r.fuelAnchorPct != null ? ` Last known ${Math.round(r.fuelAnchorPct)}%.` : ''
    return {
      tone: 'warn',
      text: 'Fuel ?',
      title: `No usable fuel reading from this truck's ELD.${known} Check the gauge before you set off.`,
    }
  }
  const mi = Math.round(Number(r.rangePlanningMiles))
  // Absolute thresholds, because the header has no route context to compare
  // against. The per-load verdict does that comparison; this is the "am I about
  // to be in trouble at all" signal.
  const tone = mi < 50 ? 'bad' : mi < 150 ? 'warn' : 'ok'
  const carried = r.fuelSource === 'carried'
    ? ' Sensor is not reporting, so this is estimated from the last reading and is a floor.'
    : ''
  return {
    tone,
    text: `${mi} mi`,
    title: `About ${mi} miles of fuel to plan on`
      + (r.fuelPct != null ? ` (${Math.round(r.fuelPct)}% in the tank)` : '')
      + '. This is the low end of the range, not the best case.' + carried,
  }
})
</script>

<style scoped>
.app-header {
  position: fixed;
  top: 0;
  left: 0;
  right: 0;
  z-index: 40;
  background: rgba(255, 255, 255, 0.85);
  backdrop-filter: blur(12px);
  -webkit-backdrop-filter: blur(12px);
  border-bottom: 1px solid var(--border);
  padding: 0.75rem 1rem;
  padding-top: calc(0.75rem + env(safe-area-inset-top, 0px));
  display: flex;
  align-items: center;
  justify-content: space-between;
}

.app-header-left {
  display: flex;
  align-items: center;
  gap: 0.5rem;
}

.header-logo {
  height: 28px;
  width: auto;
}

.driver-name-label {
  font-size: 0.85rem;
  color: var(--text-dim);
  font-weight: 500;
}

.status-chip {
  font-size: 0.65rem;
  font-weight: 600;
  padding: 0.15rem 0.4rem;
  border-radius: 999px;
  white-space: nowrap;
}
.status-chip.warn {
  background: #fef3c7;
  color: #92400e;
  border: 1px solid #fcd34d;
}
/* Fuel range chip. `ok` is deliberately neutral grey rather than green: this is
   a figure the driver reads, not an all-clear. Only the states that need acting
   on carry colour. */
.status-chip.fuel-chip {
  font-variant-numeric: tabular-nums;
}
.status-chip.fuel-chip.ok {
  background: #f1f5f9;
  color: #475569;
  border: 1px solid #e2e8f0;
}
.status-chip.fuel-chip.bad {
  background: #dc2626;
  color: #fff;
  border: 1px solid #b91c1c;
}

.app-header-right {
  display: flex;
  align-items: center;
  gap: 0.5rem;
}

.header-btn {
  background: none;
  border: 1px solid var(--border);
  border-radius: 8px;
  padding: 0.4rem 0.6rem;
  font-family: inherit;
  font-size: 0.75rem;
  color: var(--text-dim);
  cursor: pointer;
  transition: all 0.15s;
}

.header-btn:hover {
  background: var(--surface-hover);
}

.header-btn.danger {
  color: var(--danger);
  border-color: var(--danger-dim);
}

.header-btn.danger:hover {
  background: var(--danger-dim);
}
</style>
