<template>
  <div class="track-page">
    <!-- Slim public header — no sidebar, no admin chrome -->
    <header class="track-header">
      <router-link to="/track" class="track-brand">
        <img src="/logo.png" alt="LogisX" class="track-logo" />
        <span class="track-brand-text">Track Your Load</span>
      </router-link>
      <router-link v-if="loadIdParam" to="/track" class="track-another">Track another load</router-link>
    </header>

    <main class="track-main">
      <!-- No load id in URL → search card -->
      <section v-if="!loadIdParam" class="track-search-card">
        <h1 class="track-search-title">Where's my load?</h1>
        <p class="track-search-sub">Enter your Load ID to see real-time status, location, and ETA.</p>
        <form class="track-search-form" @submit.prevent="onSearch">
          <input
            ref="searchInput"
            v-model="searchInput"
            type="text"
            class="track-search-input"
            placeholder="Load ID (e.g. LD-1234)"
            autocomplete="off"
            autofocus
            maxlength="40"
          />
          <button type="submit" class="track-search-btn" :disabled="!searchInput.trim()">Track</button>
        </form>
        <p v-if="searchError" class="track-search-error">{{ searchError }}</p>
      </section>

      <!-- Loading while we fetch the tracker -->
      <section v-else-if="loading && !data" class="track-loading">
        <div class="track-spinner"></div>
        <div>Loading tracker&hellip;</div>
      </section>

      <!-- Not found -->
      <section v-else-if="notFound" class="track-notfound">
        <div class="track-notfound-icon">&#128269;</div>
        <h2>Load not found</h2>
        <p>Double-check the Load ID and try again. If you were sent a tracking link, make sure you copied the full URL.</p>
        <router-link to="/track" class="track-search-btn">Try another</router-link>
      </section>

      <!-- Tracker -->
      <section v-else-if="data" class="track-body">
        <div class="track-card track-summary">
          <div class="track-summary-head">
            <div>
              <div class="track-summary-label">Load</div>
              <div class="track-summary-id">{{ data.loadId }}</div>
            </div>
            <div class="track-status-chip" :class="statusChipClass">{{ data.status || '\u2014' }}</div>
          </div>

          <div class="track-route-line">
            <div class="track-city">
              <div class="track-city-label">FROM</div>
              <div class="track-city-name">{{ originDisplay }}</div>
            </div>
            <div class="track-route-arrow">&rarr;</div>
            <div class="track-city track-city-dest">
              <div class="track-city-label">TO</div>
              <div class="track-city-name">{{ destDisplay }}</div>
            </div>
          </div>
        </div>

        <!-- 5-stage stepper, visual only -->
        <div class="track-card track-stepper-card">
          <StatusStepper
            :load="stepperLoad"
            :headers="stepperHeaders"
            :current-status="data.status"
            :read-only="true"
          />
        </div>

        <!-- ETA or Delivered state -->
        <div class="track-card track-eta-card">
          <template v-if="data.deliveredAt">
            <div class="track-eta-label">Delivered</div>
            <div class="track-eta-value">{{ formatFriendlyDate(data.deliveredAt) }}</div>
          </template>
          <template v-else-if="data.eta">
            <div class="track-eta-top">
              <div>
                <div class="track-eta-label">Estimated arrival</div>
                <div class="track-eta-value">{{ formatEta(data.eta.minutesRemaining) }}</div>
                <div class="track-eta-sub">~{{ data.eta.distanceMiles }} mi &middot; {{ formatFriendlyDate(data.eta.expectedAt) }}</div>
              </div>
              <div v-if="data.eta.onTime !== null" class="track-eta-badge" :class="data.eta.onTime ? 'on-time' : 'delayed'">
                {{ data.eta.onTime ? 'On time' : 'Delayed' }}
              </div>
            </div>
          </template>
          <template v-else>
            <div class="track-eta-label">Estimated arrival</div>
            <div class="track-eta-value track-eta-muted">Not available yet</div>
            <div class="track-eta-sub">We'll have an ETA once the driver starts reporting location.</div>
          </template>
        </div>

        <!-- Truck unit (small card) -->
        <div v-if="data.truckUnit" class="track-card track-truck-card">
          <div class="track-truck-icon">
            <svg width="24" height="24" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.7" stroke-linecap="round" stroke-linejoin="round"><path d="M1 3h15v13H1z"/><path d="M16 8h4l3 3v5h-7z"/><circle cx="5.5" cy="18.5" r="2.5"/><circle cx="18.5" cy="18.5" r="2.5"/></svg>
          </div>
          <div>
            <div class="track-truck-label">Assigned truck</div>
            <div class="track-truck-value">Truck #{{ data.truckUnit }}</div>
          </div>
        </div>

        <!-- Live map -->
        <div v-if="mapLoad" class="track-card track-map-card">
          <div class="track-map-title">Route &amp; current location</div>
          <DriverRouteMap
            :load="mapLoad"
            :headers="mapHeaders"
            :driver-position="driverPosition"
            :public-mode="true"
            :dispatch-mode="!data.lastPing"
          />
          <div v-if="!data.lastPing" class="track-map-hint">
            GPS not available. We'll refresh automatically when the driver reports in.
          </div>
        </div>

        <!-- Footer — last-refresh indicator -->
        <div class="track-footer">
          <span class="track-refresh-dot" :class="{ pulsing: polling }"></span>
          <span>Updated {{ lastUpdatedText }} &middot; auto-refreshes every 30s</span>
        </div>
      </section>
    </main>
  </div>
</template>

<script setup>
import { ref, computed, onMounted, onUnmounted, watch, nextTick } from 'vue'
import { useRoute, useRouter } from 'vue-router'
import StatusStepper from '../components/driver/StatusStepper.vue'
import DriverRouteMap from '../components/driver/DriverRouteMap.vue'

const route = useRoute()
const router = useRouter()

const loadIdParam = computed(() => (route.params.loadId || '').toString().trim())

// -- Search card state
const searchInput = ref('')
const searchError = ref('')
function onSearch() {
  const v = searchInput.value.trim()
  if (!v) return
  if (!/^[A-Za-z0-9\-_.#]{1,40}$/.test(v)) {
    searchError.value = "Load IDs can only contain letters, numbers, and -_#."
    return
  }
  searchError.value = ''
  router.push(`/track/${encodeURIComponent(v)}`)
}

// -- Tracker state
const loading = ref(false)
const notFound = ref(false)
const data = ref(null)
const lastUpdatedAt = ref(null)
const polling = ref(false)
let pollTimer = null
let visibilityHandler = null
let tickTimer = null
const _nowTick = ref(Date.now()) // forces lastUpdatedText to re-render every 10s

async function fetchTracker() {
  if (!loadIdParam.value) return
  polling.value = true
  try {
    const res = await fetch(`/api/public/track/${encodeURIComponent(loadIdParam.value)}`, {
      headers: { Accept: 'application/json' },
      credentials: 'omit',
    })
    if (res.status === 404) {
      notFound.value = true
      data.value = null
      return
    }
    if (!res.ok) return // keep the last-good snapshot on a transient error
    const body = await res.json()
    data.value = body
    notFound.value = false
    lastUpdatedAt.value = Date.now()
  } catch {
    // Network hiccup — keep the last snapshot, try again on the next tick.
  } finally {
    loading.value = false
    polling.value = false
  }
}

function startPolling() {
  if (pollTimer) return
  pollTimer = setInterval(() => {
    if (document.visibilityState === 'visible') fetchTracker()
  }, 30_000)
}
function stopPolling() {
  if (pollTimer) { clearInterval(pollTimer); pollTimer = null }
}

// Re-fetch immediately when the user alt-tabs back into the page.
function onVisibilityChange() {
  if (document.visibilityState === 'visible') fetchTracker()
}

onMounted(async () => {
  if (loadIdParam.value) {
    loading.value = true
    await fetchTracker()
    startPolling()
    visibilityHandler = onVisibilityChange
    document.addEventListener('visibilitychange', visibilityHandler)
  }
  // Keep the "Updated X ago" label fresh even without new data.
  tickTimer = setInterval(() => { _nowTick.value = Date.now() }, 10_000)
})

onUnmounted(() => {
  stopPolling()
  if (visibilityHandler) document.removeEventListener('visibilitychange', visibilityHandler)
  if (tickTimer) clearInterval(tickTimer)
})

// Re-run fetch when the loadId param changes (e.g. /track/:id → /track/:other)
watch(loadIdParam, async (v, prev) => {
  if (v === prev) return
  data.value = null
  notFound.value = false
  if (v) {
    loading.value = true
    await fetchTracker()
    stopPolling()
    await nextTick()
    startPolling()
  } else {
    stopPolling()
  }
})

// -- Helpers that shape the server payload into what StatusStepper + DriverRouteMap expect
//
// The two reused components were built for the driver app and key off the
// Job Tracking sheet's column names. We synthesise a minimal "load" object
// and header list so they work without any driver-side context.
const stepperHeaders = ['Load ID', 'Status']
const stepperLoad = computed(() => {
  if (!data.value) return {}
  return { 'Load ID': data.value.loadId, Status: data.value.status }
})

const mapHeaders = [
  'Load ID', 'Status',
  'Origin Lat', 'Origin Lng',
  'Dest Lat', 'Dest Lng',
  'Origin', 'Destination',
]
const mapLoad = computed(() => {
  if (!data.value) return null
  const hasCoords = data.value.originLat != null && data.value.destLat != null
  if (!hasCoords && !data.value.lastPing) return null
  return {
    'Load ID': data.value.loadId,
    'Status': data.value.status,
    'Origin Lat': data.value.originLat,
    'Origin Lng': data.value.originLng,
    'Dest Lat': data.value.destLat,
    'Dest Lng': data.value.destLng,
    'Origin': `${data.value.origin.city}${data.value.origin.state ? ', ' + data.value.origin.state : ''}`,
    'Destination': `${data.value.destination.city}${data.value.destination.state ? ', ' + data.value.destination.state : ''}`,
  }
})
const driverPosition = computed(() => {
  if (!data.value || !data.value.lastPing) return null
  return { latitude: data.value.lastPing.lat, longitude: data.value.lastPing.lng }
})

const originDisplay = computed(() => {
  if (!data.value) return ''
  const { city, state } = data.value.origin
  return city ? (state ? `${city}, ${state}` : city) : '\u2014'
})
const destDisplay = computed(() => {
  if (!data.value) return ''
  const { city, state } = data.value.destination
  return city ? (state ? `${city}, ${state}` : city) : '\u2014'
})

const statusChipClass = computed(() => {
  const s = (data.value?.status || '').toLowerCase()
  if (/delivered|pod received|completed/.test(s)) return 'chip-delivered'
  if (/in transit/.test(s)) return 'chip-transit'
  if (/at receiver|unloading/.test(s)) return 'chip-receiver'
  if (/at shipper|loading/.test(s)) return 'chip-shipper'
  return 'chip-default'
})

function formatEta(minutes) {
  if (minutes == null) return '\u2014'
  if (minutes < 1) return 'Any minute now'
  if (minutes < 60) return `${minutes} min`
  const h = Math.floor(minutes / 60)
  const m = minutes % 60
  return m ? `${h}h ${m}m` : `${h}h`
}

function formatFriendlyDate(ts) {
  if (!ts) return ''
  const d = new Date(ts)
  if (isNaN(d)) return String(ts)
  return d.toLocaleString('en-US', {
    month: 'short', day: 'numeric', year: 'numeric',
    hour: 'numeric', minute: '2-digit',
  })
}

const lastUpdatedText = computed(() => {
  _nowTick.value // dep — re-compute every 10s
  if (!lastUpdatedAt.value) return 'just now'
  const ago = Math.max(0, Math.round((Date.now() - lastUpdatedAt.value) / 1000))
  if (ago < 10) return 'just now'
  if (ago < 60) return `${ago}s ago`
  const mins = Math.round(ago / 60)
  if (mins < 60) return `${mins}m ago`
  const hrs = Math.round(mins / 60)
  return `${hrs}h ago`
})
</script>

<style scoped>
.track-page {
  min-height: 100vh;
  background: #f1f5f9;
  font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', system-ui, sans-serif;
  color: #0f172a;
  display: flex;
  flex-direction: column;
}
.track-header {
  background: #ffffff;
  border-bottom: 1px solid #e2e8f0;
  padding: 0.85rem 1.25rem;
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 1rem;
}
.track-brand {
  display: flex;
  align-items: center;
  gap: 0.65rem;
  text-decoration: none;
  color: inherit;
}
.track-logo { width: 36px; height: 36px; object-fit: contain; }
.track-brand-text { font-size: 0.95rem; font-weight: 700; color: #0f3460; }
.track-another {
  font-size: 0.78rem;
  color: #475569;
  text-decoration: none;
  padding: 0.35rem 0.75rem;
  border-radius: 6px;
  border: 1px solid #e2e8f0;
  background: #fff;
  transition: all 0.15s;
}
.track-another:hover { border-color: #0f3460; color: #0f3460; }

.track-main {
  flex: 1;
  padding: 1.5rem 1rem 3rem;
  display: flex;
  justify-content: center;
  width: 100%;
}

/* ── Search card ──────────────────────────────────────── */
.track-search-card {
  width: 100%;
  max-width: 460px;
  background: #ffffff;
  border-radius: 14px;
  padding: 2.25rem 1.75rem;
  box-shadow: 0 10px 30px rgba(15, 52, 96, 0.08);
  text-align: center;
  margin-top: 3rem;
}
.track-search-title { font-size: 1.35rem; font-weight: 800; margin: 0 0 0.5rem; }
.track-search-sub { font-size: 0.88rem; color: #64748b; margin: 0 0 1.5rem; }
.track-search-form { display: flex; gap: 0.5rem; }
.track-search-input {
  flex: 1;
  padding: 0.85rem 1rem;
  border: 1px solid #cbd5e1;
  border-radius: 10px;
  font-size: 0.95rem;
  font-family: 'JetBrains Mono', ui-monospace, monospace;
  outline: none;
  transition: border-color 0.15s, box-shadow 0.15s;
}
.track-search-input:focus {
  border-color: #0f3460;
  box-shadow: 0 0 0 3px rgba(15, 52, 96, 0.12);
}
.track-search-btn {
  padding: 0.85rem 1.4rem;
  background: #0f3460;
  color: #fff;
  border: none;
  border-radius: 10px;
  font-size: 0.9rem;
  font-weight: 700;
  cursor: pointer;
  transition: opacity 0.15s;
  text-decoration: none;
  display: inline-flex;
  align-items: center;
  justify-content: center;
}
.track-search-btn:hover:not(:disabled) { opacity: 0.9; }
.track-search-btn:disabled { opacity: 0.5; cursor: not-allowed; }
.track-search-error { margin-top: 0.75rem; color: #b91c1c; font-size: 0.82rem; }

/* ── Loading / not found ─────────────────────────────── */
.track-loading, .track-notfound {
  max-width: 460px;
  text-align: center;
  margin-top: 3rem;
  color: #64748b;
  font-size: 0.9rem;
}
.track-notfound h2 { margin: 0.5rem 0; color: #0f172a; font-size: 1.1rem; }
.track-notfound p { margin-bottom: 1.25rem; }
.track-notfound-icon { font-size: 2.5rem; }
.track-spinner {
  width: 28px; height: 28px;
  border: 3px solid #e2e8f0;
  border-top-color: #0f3460;
  border-radius: 50%;
  animation: spin 0.8s linear infinite;
  margin: 0 auto 0.75rem;
}
@keyframes spin { to { transform: rotate(360deg); } }

/* ── Tracker body ────────────────────────────────────── */
.track-body {
  width: 100%;
  max-width: 720px;
  display: flex;
  flex-direction: column;
  gap: 1rem;
}
.track-card {
  background: #ffffff;
  border-radius: 14px;
  padding: 1.15rem 1.25rem;
  box-shadow: 0 6px 18px rgba(15, 52, 96, 0.06);
  border: 1px solid #e2e8f0;
}

.track-summary-head {
  display: flex;
  justify-content: space-between;
  align-items: center;
  margin-bottom: 1rem;
}
.track-summary-label {
  font-size: 0.68rem;
  font-weight: 700;
  color: #94a3b8;
  text-transform: uppercase;
  letter-spacing: 0.08em;
}
.track-summary-id {
  font-size: 1.2rem;
  font-weight: 800;
  font-family: 'JetBrains Mono', ui-monospace, monospace;
}
.track-status-chip {
  padding: 0.35rem 0.75rem;
  font-size: 0.72rem;
  font-weight: 700;
  border-radius: 9999px;
  white-space: nowrap;
  text-transform: uppercase;
  letter-spacing: 0.04em;
}
.chip-default   { background: #f1f5f9; color: #475569; }
.chip-shipper   { background: #dbeafe; color: #1d4ed8; }
.chip-transit   { background: #fef3c7; color: #b45309; }
.chip-receiver  { background: #e0e7ff; color: #4338ca; }
.chip-delivered { background: #dcfce7; color: #166534; }

.track-route-line {
  display: flex;
  align-items: center;
  gap: 0.75rem;
  padding: 0.85rem 0 0.35rem;
  border-top: 1px solid #f1f5f9;
}
.track-city { flex: 1; min-width: 0; }
.track-city-dest { text-align: right; }
.track-city-label {
  font-size: 0.62rem;
  font-weight: 700;
  color: #94a3b8;
  letter-spacing: 0.08em;
  margin-bottom: 0.2rem;
}
.track-city-name {
  font-size: 0.95rem;
  font-weight: 700;
  color: #0f172a;
  white-space: nowrap;
  overflow: hidden;
  text-overflow: ellipsis;
}
.track-route-arrow { color: #cbd5e1; font-size: 1.4rem; flex-shrink: 0; }

.track-stepper-card { padding: 0.5rem 0.5rem 0.25rem; }

.track-eta-top {
  display: flex;
  justify-content: space-between;
  align-items: flex-start;
  gap: 1rem;
}
.track-eta-label {
  font-size: 0.68rem;
  font-weight: 700;
  color: #94a3b8;
  text-transform: uppercase;
  letter-spacing: 0.08em;
}
.track-eta-value {
  font-size: 1.5rem;
  font-weight: 800;
  margin-top: 0.25rem;
}
.track-eta-value.track-eta-muted { color: #94a3b8; font-size: 1.1rem; font-weight: 600; }
.track-eta-sub { font-size: 0.78rem; color: #64748b; margin-top: 0.35rem; }
.track-eta-badge {
  padding: 0.3rem 0.65rem;
  font-size: 0.7rem;
  font-weight: 700;
  border-radius: 9999px;
  letter-spacing: 0.04em;
  text-transform: uppercase;
  white-space: nowrap;
  flex-shrink: 0;
}
.track-eta-badge.on-time  { background: #dcfce7; color: #166534; }
.track-eta-badge.delayed  { background: #fee2e2; color: #b91c1c; }

.track-truck-card { display: flex; align-items: center; gap: 0.85rem; }
.track-truck-icon {
  width: 44px; height: 44px;
  border-radius: 10px;
  background: #eff6ff;
  color: #1d4ed8;
  display: flex;
  align-items: center;
  justify-content: center;
  flex-shrink: 0;
}
.track-truck-label {
  font-size: 0.68rem;
  font-weight: 700;
  color: #94a3b8;
  text-transform: uppercase;
  letter-spacing: 0.08em;
}
.track-truck-value { font-size: 1rem; font-weight: 700; margin-top: 0.15rem; }

.track-map-card { padding-bottom: 0.85rem; }
.track-map-title {
  font-size: 0.72rem;
  font-weight: 700;
  color: #94a3b8;
  text-transform: uppercase;
  letter-spacing: 0.08em;
  margin-bottom: 0.75rem;
}
.track-map-hint {
  font-size: 0.78rem;
  color: #64748b;
  margin-top: 0.6rem;
  text-align: center;
  font-style: italic;
}

.track-footer {
  display: flex;
  align-items: center;
  gap: 0.5rem;
  justify-content: center;
  padding: 0.5rem;
  font-size: 0.72rem;
  color: #94a3b8;
}
.track-refresh-dot {
  width: 8px; height: 8px;
  border-radius: 50%;
  background: #94a3b8;
  transition: background 0.3s, transform 0.3s;
}
.track-refresh-dot.pulsing {
  background: #10b981;
  transform: scale(1.3);
}
</style>
