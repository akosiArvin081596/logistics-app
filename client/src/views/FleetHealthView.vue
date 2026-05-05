<template>
  <div class="fleet-health-page admin-page" style="overflow-y:auto;min-height:auto;flex:none;">
    <div class="page-header">
      <h2>Fleet Health</h2>
      <p class="page-desc">
        Per-truck telemetry from Routemate ELD devices. Speed, idle time, and fuel level
        update every 60 seconds. Trucks without a linked Routemate device or with no recent
        ping appear as <span class="src-pill src-stale">stale</span> or
        <span class="src-pill src-unlinked">unlinked</span>.
      </p>
    </div>

    <div class="fh-toolbar">
      <input
        v-model="search"
        type="text"
        class="fh-search"
        placeholder="Search by unit number, driver, or location..."
      />
      <div class="fh-toolbar-right">
        <span v-if="lastRefreshAt" class="fh-refresh-meta">
          Refreshed {{ formatAge(lastRefreshAt) }}
        </span>
        <button class="btn btn-secondary btn-sm" :disabled="loading" @click="refresh">
          {{ loading ? 'Loading...' : 'Refresh' }}
        </button>
      </div>
    </div>

    <div v-if="loading && trucks.length === 0" class="fh-empty">Loading fleet telemetry...</div>
    <div v-else-if="error" class="fh-error">{{ error }}</div>
    <div v-else-if="trucks.length === 0" class="fh-empty">No trucks in fleet.</div>
    <div v-else class="card">
      <table class="fh-table">
        <thead>
          <tr>
            <th>Unit</th>
            <th>Driver</th>
            <th>Source</th>
            <th>Speed</th>
            <th>Idle</th>
            <th>Fuel</th>
            <th title="7-day average miles per gallon, derived from telemetry. Tank size assumed 200 gal.">MPG (7d)</th>
            <th>Last Fix</th>
            <th>Location</th>
          </tr>
        </thead>
        <tbody>
          <tr v-for="t in filteredTrucks" :key="t.truckId" :class="{ 'row-stale': t.source === 'stale' }">
            <td class="mono">{{ t.unitNumber }}</td>
            <td>{{ t.assignedDriver || '—' }}</td>
            <td>
              <span :class="['src-pill', sourceClass(t.source)]">{{ sourceLabel(t.source) }}</span>
            </td>
            <td class="mono">{{ t.speedMph != null ? t.speedMph + ' mph' : '—' }}</td>
            <td class="mono">{{ formatIdle(t) }}</td>
            <td class="mono">{{ t.fuelPct != null ? t.fuelPct + '%' : '—' }}</td>
            <td class="mono">{{ formatMpg(t.truckId) }}</td>
            <td class="mono fh-age">{{ t.lastFixAgeSec != null ? formatAgeSec(t.lastFixAgeSec) : '—' }}</td>
            <td class="fh-location">{{ t.geocodedLocation || '—' }}</td>
          </tr>
        </tbody>
      </table>
      <div class="fh-summary">
        Showing {{ filteredTrucks.length }} of {{ trucks.length }} trucks &middot;
        {{ liveCount }} live &middot;
        {{ staleCount }} stale &middot;
        {{ unlinkedCount }} unlinked
      </div>
    </div>
  </div>
</template>

<script setup>
import { ref, computed, onMounted, onUnmounted } from 'vue'
import { useApi } from '../composables/useApi'

const api = useApi()
const trucks = ref([])
const fuelByTruck = ref({})
const loading = ref(false)
const error = ref('')
const search = ref('')
const lastRefreshAt = ref(null)
let pollTimer = null

async function refresh() {
  loading.value = true
  error.value = ''
  try {
    // Fetch in parallel — fuel summary changes infrequently but keeping the
    // calls together avoids a second waterfall.
    const [fleet, fuel] = await Promise.all([
      api.get('/api/admin/fleet-health'),
      api.get('/api/routemate/fuel/summary?days=7').catch(() => ({ trucks: [] })),
    ])
    trucks.value = fleet.trucks || []
    const map = {}
    for (const f of (fuel.trucks || [])) map[f.truckId] = f
    fuelByTruck.value = map
    lastRefreshAt.value = Date.now()
  } catch (err) {
    error.value = err?.message || 'Failed to load fleet health.'
  } finally {
    loading.value = false
  }
}

function formatMpg(truckId) {
  const f = fuelByTruck.value[truckId]
  if (!f || f.mpgAvg == null) return '—'
  return f.mpgAvg.toFixed(1)
}

const filteredTrucks = computed(() => {
  const q = search.value.trim().toLowerCase()
  if (!q) return trucks.value
  return trucks.value.filter(t =>
    (t.unitNumber || '').toLowerCase().includes(q) ||
    (t.assignedDriver || '').toLowerCase().includes(q) ||
    (t.geocodedLocation || '').toLowerCase().includes(q)
  )
})

const liveCount = computed(() => trucks.value.filter(t => t.source === 'routemate').length)
const staleCount = computed(() => trucks.value.filter(t => t.source === 'stale').length)
const unlinkedCount = computed(() => trucks.value.filter(t => t.source === 'unlinked').length)

function sourceClass(s) {
  if (s === 'routemate') return 'src-eld'
  if (s === 'stale') return 'src-stale'
  return 'src-unlinked'
}
function sourceLabel(s) {
  if (s === 'routemate') return 'ELD live'
  if (s === 'stale') return 'ELD stale'
  return 'Unlinked'
}
function formatIdle(t) {
  if (t.idleSeconds == null) return '—'
  if (t.idleSeconds === 0) return 'Moving'
  return formatAgeSec(t.idleSeconds)
}
function formatAgeSec(s) {
  if (s < 60) return s + 's'
  if (s < 3600) return Math.round(s / 60) + 'm'
  if (s < 86400) return Math.round(s / 3600) + 'h'
  return Math.round(s / 86400) + 'd'
}
function formatAge(ms) {
  return formatAgeSec(Math.round((Date.now() - ms) / 1000)) + ' ago'
}

onMounted(() => {
  refresh()
  // Auto-refresh every 30s while the page is open. Background tabs throttle
  // setInterval, which is fine — fresher data is on demand via Refresh button.
  pollTimer = setInterval(refresh, 30000)
})
onUnmounted(() => {
  if (pollTimer) clearInterval(pollTimer)
})
</script>

<style scoped>
.page-header { margin-bottom: 1rem; }
.page-header h2 { margin: 0 0 0.25rem; font-size: 1.4rem; }
.page-desc { font-size: 0.82rem; color: var(--text-dim); line-height: 1.45; margin: 0; }

.fh-toolbar {
  display: flex; align-items: center; justify-content: space-between;
  gap: 0.75rem; margin-bottom: 0.85rem; flex-wrap: wrap;
}
.fh-search {
  flex: 1; min-width: 240px;
  padding: 0.5rem 0.75rem;
  border: 1px solid var(--border); border-radius: 6px;
  font-family: inherit; font-size: 0.85rem;
  background: var(--surface); color: var(--text);
}
.fh-toolbar-right { display: flex; align-items: center; gap: 0.6rem; }
.fh-refresh-meta { font-size: 0.72rem; color: var(--text-dim); }

.card {
  background: var(--surface); border: 1px solid var(--border);
  border-radius: var(--radius); padding: 0; overflow: hidden;
}

.fh-table {
  width: 100%; border-collapse: separate; border-spacing: 0;
  font-size: 0.82rem;
}
.fh-table th {
  text-align: left; padding: 0.65rem 0.75rem; font-weight: 600;
  color: var(--text-dim); border-bottom: 2px solid var(--border);
  font-size: 0.66rem; text-transform: uppercase; letter-spacing: 0.05em;
  background: var(--bg);
  position: sticky; top: 0;
}
.fh-table td {
  padding: 0.7rem 0.75rem; border-bottom: 1px solid var(--bg);
  vertical-align: middle;
}
.fh-table tbody tr:last-child td { border-bottom: none; }
.fh-table tbody tr:hover { background: var(--bg); }

.row-stale td { opacity: 0.65; }

.mono { font-family: 'JetBrains Mono', monospace; font-size: 0.78rem; }
.fh-age { color: var(--text-dim); }
.fh-location {
  font-size: 0.78rem; color: var(--text);
  max-width: 320px; overflow: hidden; text-overflow: ellipsis; white-space: nowrap;
}

.src-pill {
  display: inline-block;
  font-size: 0.6rem; font-weight: 700; letter-spacing: 0.04em;
  padding: 2px 7px; border-radius: 4px;
  text-transform: uppercase;
}
.src-pill.src-eld {
  background: #dcfce7; color: #166534; border: 1px solid #bbf7d0;
}
.src-pill.src-stale {
  background: #fef9c3; color: #854d0e; border: 1px solid #fde68a;
}
.src-pill.src-unlinked {
  background: #f3f4f6; color: #4b5563; border: 1px solid #e5e7eb;
}

.fh-summary {
  padding: 0.65rem 0.75rem;
  background: var(--bg);
  font-size: 0.72rem; color: var(--text-dim);
  border-top: 1px solid var(--border);
}

.fh-empty, .fh-error {
  padding: 2rem; text-align: center;
  background: var(--surface); border: 1px solid var(--border);
  border-radius: var(--radius); font-size: 0.85rem;
}
.fh-error { color: var(--danger); }

.btn {
  border: none; padding: 0.5rem 1rem; border-radius: 6px;
  cursor: pointer; font-family: inherit; font-size: 0.82rem;
  transition: opacity 0.1s; font-weight: 500;
}
.btn:disabled { opacity: 0.5; cursor: not-allowed; }
.btn-secondary {
  background: var(--bg); border: 1px solid var(--border); color: var(--text-dim);
}
.btn-sm { padding: 0.35rem 0.7rem; font-size: 0.75rem; }
</style>
