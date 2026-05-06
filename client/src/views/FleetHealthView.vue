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
            <th title="Open ELD fault codes (DTCs) — click count to view + acknowledge.">Faults</th>
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
            <td>
              <button
                v-if="faultCountFor(t.truckId) > 0"
                class="fault-pill"
                @click.stop="openFaultsModal(t)"
              >{{ faultCountFor(t.truckId) }} open</button>
              <span v-else class="mono fh-age">—</span>
            </td>
            <td class="mono fh-age">{{ t.lastFixAgeSec != null ? formatAgeSec(t.lastFixAgeSec) : '—' }}</td>
            <td class="fh-location">{{ t.geocodedLocation || '—' }}</td>
          </tr>
        </tbody>
      </table>
      <div class="fh-summary">
        Showing {{ filteredTrucks.length }} of {{ trucks.length }} trucks &middot;
        {{ liveCount }} live &middot;
        {{ staleCount }} stale &middot;
        {{ unlinkedCount }} unlinked &middot;
        {{ totalOpenFaults }} open faults
      </div>
    </div>

    <!-- Faults modal — lists open ELD fault codes for a single truck with
         per-row Acknowledge buttons. Acked faults stop counting toward the
         badge but stay in the table for audit. -->
    <Teleport to="body">
      <div v-if="faultsModalOpen" class="fh-overlay" @click.self="closeFaultsModal">
        <div class="fh-dialog">
          <div class="fh-dialog-header">
            <span>Open ELD Faults — {{ faultsModalTruck?.unitNumber || '' }}</span>
            <button class="fh-x" @click="closeFaultsModal">&times;</button>
          </div>
          <div class="fh-dialog-body">
            <div v-if="faultsLoading" class="fh-empty">Loading...</div>
            <div v-else-if="faultsForModal.length === 0" class="fh-empty">No open faults for this truck.</div>
            <table v-else class="fh-fault-table">
              <thead>
                <tr><th>Code</th><th>Status</th><th>First Seen</th><th>Last Seen</th><th></th></tr>
              </thead>
              <tbody>
                <tr v-for="f in faultsForModal" :key="f.id">
                  <td class="mono bold">{{ f.code }}</td>
                  <td class="mono">{{ f.status || '—' }}</td>
                  <td class="mono fh-age">{{ formatTs(f.first_seen) }}</td>
                  <td class="mono fh-age">{{ formatTs(f.last_seen) }}</td>
                  <td>
                    <button
                      class="btn btn-secondary btn-sm"
                      :disabled="ackBusy === f.id"
                      @click="ackFault(f.id)"
                    >{{ ackBusy === f.id ? 'Ack...' : 'Acknowledge' }}</button>
                  </td>
                </tr>
              </tbody>
            </table>
          </div>
        </div>
      </div>
    </Teleport>
  </div>
</template>

<script setup>
import { ref, computed, onMounted, onUnmounted } from 'vue'
import { useApi } from '../composables/useApi'

const api = useApi()
const trucks = ref([])
const fuelByTruck = ref({})
const faultCountByTruck = ref({})
const loading = ref(false)
const error = ref('')
const search = ref('')
const lastRefreshAt = ref(null)
let pollTimer = null

// Faults modal state
const faultsModalOpen = ref(false)
const faultsModalTruck = ref(null)
const faultsForModal = ref([])
const faultsLoading = ref(false)
const ackBusy = ref(0)

async function refresh() {
  loading.value = true
  error.value = ''
  try {
    // Three parallel fetches — fleet, fuel, fault counts. The summary endpoints
    // are cheap (one per-truck SQL count) so doing them every 30s is fine.
    const [fleet, fuel, faults] = await Promise.all([
      api.get('/api/admin/fleet-health'),
      api.get('/api/routemate/fuel/summary?days=7').catch(() => ({ trucks: [] })),
      api.get('/api/routemate/fault-codes/summary').catch(() => ({ trucks: [] })),
    ])
    trucks.value = fleet.trucks || []
    const fuelMap = {}
    for (const f of (fuel.trucks || [])) fuelMap[f.truckId] = f
    fuelByTruck.value = fuelMap
    const faultMap = {}
    for (const f of (faults.trucks || [])) faultMap[f.truckId] = f.openFaults || 0
    faultCountByTruck.value = faultMap
    lastRefreshAt.value = Date.now()
  } catch (err) {
    error.value = err?.message || 'Failed to load fleet health.'
  } finally {
    loading.value = false
  }
}

function faultCountFor(truckId) {
  return faultCountByTruck.value[truckId] || 0
}

const totalOpenFaults = computed(() => {
  let n = 0
  for (const v of Object.values(faultCountByTruck.value)) n += v
  return n
})

async function openFaultsModal(truck) {
  faultsModalTruck.value = truck
  faultsModalOpen.value = true
  faultsForModal.value = []
  faultsLoading.value = true
  try {
    const r = await api.get('/api/routemate/fault-codes')
    faultsForModal.value = (r.faults || []).filter(f => f.truckId === truck.truckId)
  } catch {
    faultsForModal.value = []
  } finally {
    faultsLoading.value = false
  }
}

function closeFaultsModal() {
  if (ackBusy.value) return
  faultsModalOpen.value = false
  faultsModalTruck.value = null
  faultsForModal.value = []
}

async function ackFault(faultId) {
  ackBusy.value = faultId
  try {
    await api.post(`/api/routemate/fault-codes/${faultId}/ack`, {})
    // Drop from the modal list immediately + decrement the per-truck count.
    faultsForModal.value = faultsForModal.value.filter(f => f.id !== faultId)
    if (faultsModalTruck.value) {
      const tid = faultsModalTruck.value.truckId
      faultCountByTruck.value = {
        ...faultCountByTruck.value,
        [tid]: Math.max(0, (faultCountByTruck.value[tid] || 0) - 1),
      }
    }
  } catch {
    // Silent — the modal will retry on next refresh.
  } finally {
    ackBusy.value = 0
  }
}

function formatTs(s) {
  if (!s) return '—'
  // SQLite returns "YYYY-MM-DD HH:MM:SS" (UTC); render relative.
  const d = new Date(s.replace(' ', 'T') + 'Z')
  if (isNaN(d.getTime())) return s
  return formatAgeSec(Math.round((Date.now() - d.getTime()) / 1000)) + ' ago'
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

/* Fault count pill — clickable, opens the faults modal for the truck */
.fault-pill {
  border: 1px solid #fecaca;
  background: #fef2f2;
  color: #991b1b;
  padding: 2px 9px;
  border-radius: 10px;
  font-size: 0.7rem;
  font-weight: 700;
  letter-spacing: 0.02em;
  font-family: inherit;
  cursor: pointer;
  transition: background 0.15s;
}
.fault-pill:hover { background: #fecaca; }

/* Faults modal */
.fh-overlay {
  position: fixed; inset: 0;
  background: rgba(0,0,0,0.45);
  display: flex; align-items: center; justify-content: center;
  z-index: 200;
}
.fh-dialog {
  background: var(--surface);
  border-radius: var(--radius);
  width: 90%; max-width: 720px;
  max-height: 80vh; overflow: hidden;
  display: flex; flex-direction: column;
  box-shadow: 0 20px 50px rgba(0,0,0,0.25);
}
.fh-dialog-header {
  display: flex; align-items: center; justify-content: space-between;
  padding: 0.85rem 1.1rem;
  border-bottom: 1px solid var(--border);
  font-size: 0.92rem; font-weight: 700;
}
.fh-x {
  background: none; border: none; cursor: pointer;
  font-size: 1.4rem; line-height: 1; color: var(--text-dim);
  padding: 0 0.4rem;
}
.fh-x:hover { color: var(--text); }
.fh-dialog-body {
  padding: 1rem; overflow-y: auto; flex: 1;
}
.fh-fault-table {
  width: 100%; border-collapse: collapse;
  font-size: 0.82rem;
}
.fh-fault-table th {
  text-align: left; padding: 0.5rem 0.6rem;
  font-size: 0.66rem; text-transform: uppercase; letter-spacing: 0.05em;
  color: var(--text-dim); border-bottom: 1px solid var(--border);
}
.fh-fault-table td {
  padding: 0.55rem 0.6rem; border-bottom: 1px solid var(--bg);
}
.fh-fault-table .bold { font-weight: 700; }
</style>
