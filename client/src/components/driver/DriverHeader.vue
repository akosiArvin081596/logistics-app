<template>
  <header ref="headerEl" class="app-header">
    <div class="app-header-left">
      <img src="/logo.png" alt="LogisX" class="header-logo" />
      <span class="driver-name-label">{{ driverName }}</span>
      <span
        v-if="socketConnected === false && hasEverConnected"
        class="status-chip warn"
        title="Real-time connection lost — trying to reconnect"
      >&#9888; Offline</span>
    </div>
    <!-- Fuel range, on every driver screen.
         The client's ask after the 2026-08-17 run-dry was that range be
         "displayed throughout even when they park even when they're idling".
         The detailed panel lives behind a tap inside one load's detail screen,
         and a driver who runs dry is by definition one who never opened it —
         so the number has to sit somewhere they cannot miss. This is that
         somewhere. It is driver-scoped server-side (no params), so it costs
         one indexed read and cannot leak another truck's state.
         A hidden stand-in with the chip's own box holds the row until the first
         answer, so a phone's page doesn't move under the driver's thumb when the
         sentence arrives.
         A button only where a tap has somewhere to go: the lock screens have no
         loads, so their chip stays plain rather than do nothing when tapped. -->
    <div v-if="auth.isDriver" class="fuel-row">
      <button
        v-if="fuelChip && fuelChipTaps"
        type="button"
        class="status-chip fuel-chip fuel-tap"
        :class="fuelChip.tone"
        :title="fuelChip.title"
        :aria-label="`${fuelChip.text}. Show details`"
        @click="tapFuel"
      >&#9981; {{ fuelChip.text }}</button>
      <span
        v-else-if="fuelChip"
        class="status-chip fuel-chip"
        :class="fuelChip.tone"
        :title="fuelChip.title"
      >&#9981; {{ fuelChip.text }}</span>
      <span v-else class="status-chip fuel-held">&#9981;</span>
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
import { useAuthStore } from '../../stores/auth'
import { driverFuelOf, driverFuelChip, fuelRangeText, fuelRangeTitle, refuelNowTitle, FUEL_RANGE_NOT_AVAILABLE } from '../../lib/driverFuelView'

defineProps({
  driverName: { type: String, default: '' },
  socketConnected: { type: Boolean, default: true },
  hasEverConnected: { type: Boolean, default: false },
  fuelChipTaps: { type: Boolean, default: false },
})

const emit = defineEmits(['logout', 'fuel-tap'])

const showPwModal = ref(false)

// Every dialog sits above this fixed header, so a finger can't reach the chip under
// one, but a keyboard or a screen reader can: that press must not change the screen
// behind the dialog. Asking what's on top covers any overlay, without a list of them.
function chipIsCovered(el) {
  if (typeof document.elementFromPoint !== 'function') return false
  const box = el.getBoundingClientRect()
  const top = document.elementFromPoint(box.left + box.width / 2, box.top + box.height / 2)
  return !!top && !el.contains(top)
}

function tapFuel(event) {
  if (chipIsCovered(event.currentTarget)) return
  emit('fuel-tap', fuelChip.value.title)
}

/* ── the header's height, for the page below it ───────────────────────────
   The header is fixed, so the page can't make room for it by itself, and its
   height moves with the screen width and the driver's name. DriverView starts
   the page at this height. */
const HEIGHT_VAR = '--driver-header-height'
const headerEl = ref(null)
let stopWatchingHeight = null

function watchHeaderHeight() {
  const el = headerEl.value
  if (!el) return
  const root = document.documentElement
  const write = () => root.style.setProperty(HEIGHT_VAR, `${el.offsetHeight}px`)
  write()
  const watcher = typeof ResizeObserver === 'undefined' ? null : new ResizeObserver(write)
  if (watcher) watcher.observe(el)
  stopWatchingHeight = () => {
    if (watcher) watcher.disconnect()
    root.style.removeProperty(HEIGHT_VAR)
  }
}

/* ── persistent fuel range ────────────────────────────────────────────────
   A Driver session resolves its own truck server-side, so this sends NO
   params — see the scoping note on GET /api/fuel/range. Polled slowly: the
   endpoint is local SQLite only (no Google/Places call), and fuel does not
   move fast enough to justify anything tighter. Only a Driver session asks:
   anyone else has to name a driver or vehicle and this header has neither,
   so a Super Admin opening /driver would get a 400 on every poll. */
const api = useApi()
const auth = useAuthStore()
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
  watchHeaderHeight()
  if (!auth.isDriver) return
  loadRange()
  timer = setInterval(loadRange, 120000)
})
onBeforeUnmount(() => {
  if (timer) clearInterval(timer)
  if (stopWatchingHeight) stopWatchingHeight()
})

const fuelChip = computed(() => {
  const r = range.value
  if (!r) return null
  // Driver gallons flag on: the chip's text, tooltip and colour all come from the
  // block the load's Fuel section reads, so the two can't disagree.
  const block = driverFuelOf(r)
  if (block) {
    const c = driverFuelChip(block)
    return { tone: c.tone, text: c.text, title: c.title }
  }
  // No usable reading — say so rather than showing a comforting blank. 'stale'
  // means the ELD stopped reporting entirely; we deliberately publish no number
  // for it (a dead device's last reading is not a range).
  if (!r.hasFuelData || r.rangePlanningMiles == null) {
    const known = r.fuelAnchorPct != null ? ` Last known ${Math.round(r.fuelAnchorPct)}%.` : ''
    return {
      tone: 'warn',
      text: FUEL_RANGE_NOT_AVAILABLE,
      title: `No usable fuel reading from this truck's ELD.${known} Check the gauge before you set off.`,
    }
  }
  const dry = Math.round(Number(r.rangePlanningMiles))
  // The chip carries the USABLE figure — miles before a stop is mandatory —
  // so the driver's phone and the dispatcher's Fuel & Route card cannot quote
  // two different numbers for the same truck. An older server sends no reserve,
  // in which case the chip quotes the distance to dry.
  const usable = r.rangeUsableMiles == null ? null : Math.round(Number(r.rangeUsableMiles))
  const reserve = r.reserveMiles == null ? null : Math.round(Number(r.reserveMiles))
  const hasReserve = usable !== null && reserve !== null
  // Thresholds stay on the DRY figure. They were calibrated against it, and
  // re-pointing them at a number that is 15 lower would quietly move every
  // driver 15 miles closer to a red chip without anyone deciding to.
  // Absolute thresholds, because the header has no route context to compare
  // against. The per-load verdict does that comparison; this is the "am I about
  // to be in trouble at all" signal.
  const tone = dry < 50 ? 'bad' : dry < 150 ? 'warn' : 'ok'
  const estimate = r.fuelSource === 'carried'
  if (hasReserve) {
    return {
      tone: usable === 0 ? 'bad' : tone,
      // 0 usable miles is an instruction, not a measurement.
      text: usable === 0 ? 'Refuel now' : fuelRangeText(usable),
      title: usable === 0 ? refuelNowTitle(estimate) : fuelRangeTitle(usable, estimate),
    }
  }
  return { tone, text: fuelRangeText(dry), title: fuelRangeTitle(dry, estimate) }
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
  padding: 0.75rem max(1rem, env(safe-area-inset-right, 0px)) 0.75rem max(1rem, env(safe-area-inset-left, 0px));
  padding-top: calc(0.75rem + env(safe-area-inset-top, 0px));
  display: grid;
  grid-template-columns: minmax(0, 1fr) auto;
  gap: 0.35rem 0.5rem;
  align-items: center;
}

.app-header-left {
  grid-row: 1;
  grid-column: 1;
  min-width: 0;
  display: flex;
  align-items: center;
  gap: 0.5rem;
}

/* The fuel sentence has no room beside the name and the buttons on a phone, so it
   takes its own row there. From the tablet width up, it sits after the name. */
.fuel-row {
  grid-row: 2;
  grid-column: 1 / -1;
  min-width: 0;
  display: flex;
  align-items: center;
}

.header-logo {
  height: 28px;
  width: auto;
}

.driver-name-label {
  font-size: 0.85rem;
  color: var(--text-dim);
  font-weight: 500;
  /* One line, whatever the length: Offline comes and goes beside the name, and a name
     that wrapped would regrow the header and move the page under the driver's thumb. */
  min-width: 0;
  white-space: nowrap;
  overflow: hidden;
  text-overflow: ellipsis;
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
.status-chip.fuel-chip,
.status-chip.fuel-held {
  font-size: 0.75rem;
}
.status-chip.fuel-chip {
  font-variant-numeric: tabular-nums;
  /* On the narrowest screens the sentence wraps inside the chip instead of running off it. */
  white-space: normal;
}
/* Same font, padding and border width as the chip, so the row is the same height
   with or without it. Every chip colour has a 1px border. */
.status-chip.fuel-held {
  visibility: hidden;
  border: 1px solid transparent;
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
/* The chip as a button keeps the plain chip's box, so the row and the stand-in stay
   right and nothing moves: only what a browser gives a button by default is undone. */
.status-chip.fuel-tap {
  position: relative;
  font-family: inherit;
  line-height: inherit;
  text-align: left;
  cursor: pointer;
  appearance: none;
  -webkit-appearance: none;
  touch-action: manipulation;
}
/* A 44 px target with no taller row. Upward it reaches only into the row gap, so it
   can't take a tap from Password or Logout above; the rest of the height goes down. */
.status-chip.fuel-tap::after {
  content: '';
  position: absolute;
  top: -0.35rem;
  left: -1px;
  right: -1px;
  bottom: 0;
  min-height: 44px;
}
.status-chip.fuel-tap:active {
  opacity: 0.8;
}
.status-chip.fuel-tap:focus-visible {
  outline: 2px solid #1d4ed8;
  outline-offset: 2px;
}

.app-header-right {
  grid-row: 1;
  grid-column: 2;
  display: flex;
  align-items: center;
  gap: 0.5rem;
}

@media (min-width: 768px) {
  .app-header {
    grid-template-columns: auto minmax(max-content, 1fr) auto;
  }
  .fuel-row {
    grid-row: 1;
    grid-column: 2;
  }
  .app-header-right {
    grid-column: 3;
  }
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
