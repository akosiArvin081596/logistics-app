<template>
  <div class="admin-page">
    <div class="page-header">
      <h2>Driver Pay Overrides</h2>
      <p class="page-desc">
        Manually adjust the "days worked" count for any driver. Use <strong>Add</strong> when the ELD missed a day the driver actually worked (truck offline, lost feed), and <strong>Remove</strong> when the ELD over-counted (parked-but-creeping ping, midnight boundary).
        Changes apply in lockstep across the investor portal, company P&amp;L, and weekly invoices.
      </p>
    </div>

    <!-- Add Override -->
    <div class="card">
      <div class="card-header">
        <div class="card-title">
          <div class="section-dot" style="background: var(--accent);"></div>
          Add Override
        </div>
      </div>
      <div class="card-body">
        <form class="form-grid" @submit.prevent="submitOverride">
          <label class="field">
            <span class="field-label">Driver</span>
            <select v-model="form.driverName" required class="field-input">
              <option value="" disabled>Choose a driver…</option>
              <option v-for="d in drivers" :key="d" :value="d">{{ d }}</option>
            </select>
          </label>

          <label class="field">
            <span class="field-label">Date</span>
            <input v-model="form.date" type="date" required class="field-input" />
          </label>

          <label class="field">
            <span class="field-label">Action</span>
            <div class="action-toggle">
              <label class="radio-pill" :class="{ active: form.action === 'add' }">
                <input v-model="form.action" type="radio" value="add" />
                <span>+ Add day (credit)</span>
              </label>
              <label class="radio-pill" :class="{ active: form.action === 'remove' }">
                <input v-model="form.action" type="radio" value="remove" />
                <span>− Remove day (exclude)</span>
              </label>
            </div>
          </label>

          <label class="field field-wide">
            <span class="field-label">Reason <span class="field-hint">(optional, recorded in audit trail)</span></span>
            <input v-model="form.reason" type="text" maxlength="500" class="field-input" placeholder="e.g. Truck ELD offline / Parked but ping registered movement" />
          </label>

          <div class="field-actions">
            <button type="submit" class="btn btn-primary" :disabled="busy || !form.driverName || !form.date">
              {{ busy ? 'Saving…' : (form.action === 'add' ? 'Add day' : 'Remove day') }}
            </button>
          </div>
        </form>
      </div>
    </div>

    <!-- Current Overrides -->
    <div class="card">
      <div class="card-header">
        <div class="card-title">
          <div class="section-dot" style="background: var(--amber);"></div>
          Current Overrides
          <span class="count-badge">{{ filteredOverrides.length }}</span>
        </div>
        <div class="filter-row">
          <select v-model="filterDriver" class="filter-input">
            <option value="">All drivers</option>
            <option v-for="d in driversWithOverrides" :key="d" :value="d">{{ d }}</option>
          </select>
          <select v-model="filterAction" class="filter-input">
            <option value="">All actions</option>
            <option value="add">Added only</option>
            <option value="remove">Removed only</option>
          </select>
          <button class="btn btn-secondary btn-sm" :disabled="loading" @click="loadOverrides">
            {{ loading ? 'Loading…' : 'Refresh' }}
          </button>
        </div>
      </div>

      <div v-if="loading && !overrides.length" class="card-body scan-empty">Loading…</div>
      <div v-else-if="filteredOverrides.length === 0" class="card-body scan-empty">
        {{ overrides.length === 0 ? 'No overrides yet — the active-day count is fully computed from completed loads × ELD travel.' : 'No overrides match the filters.' }}
      </div>
      <div v-else class="card-body table-wrap">
        <table class="ovr-table">
          <thead>
            <tr>
              <th>Driver</th>
              <th>Date</th>
              <th>Action</th>
              <th>Reason</th>
              <th>By</th>
              <th>When</th>
              <th></th>
            </tr>
          </thead>
          <tbody>
            <tr v-for="row in filteredOverrides" :key="row.id">
              <td class="cell-driver">{{ titleCase(row.driver_name) }}</td>
              <td class="cell-date">{{ formatDate(row.excluded_date) }}</td>
              <td>
                <span :class="['action-badge', row.action]">
                  {{ row.action === 'add' ? '+ Added' : '− Removed' }}
                </span>
              </td>
              <td class="cell-reason" :title="row.reason || ''">{{ row.reason || '—' }}</td>
              <td class="cell-by">{{ row.excluded_by || '—' }}</td>
              <td class="cell-when">{{ formatTs(row.excluded_at) }}</td>
              <td>
                <button class="btn btn-danger btn-xs" :disabled="busyId === row.id" @click="removeOverride(row)">
                  {{ busyId === row.id ? '…' : 'Remove' }}
                </button>
              </td>
            </tr>
          </tbody>
        </table>
      </div>
    </div>
  </div>
</template>

<script setup>
import { ref, computed, onMounted, reactive } from 'vue'
import { useApi } from '../composables/useApi'
import { useToast } from '../composables/useToast'

const api = useApi()
const { show: toast } = useToast()

const overrides = ref([])
const drivers = ref([])
const loading = ref(false)
const busy = ref(false)
const busyId = ref(0)

const filterDriver = ref('')
const filterAction = ref('')

const form = reactive({
  driverName: '',
  date: '',
  action: 'add',
  reason: '',
})

const driversWithOverrides = computed(() => {
  const set = new Set(overrides.value.map(o => o.driver_name))
  return [...set].sort((a, b) => a.localeCompare(b))
})

const filteredOverrides = computed(() => {
  return overrides.value.filter(o => {
    if (filterDriver.value && o.driver_name !== filterDriver.value) return false
    if (filterAction.value && o.action !== filterAction.value) return false
    return true
  })
})

async function loadOverrides() {
  loading.value = true
  try {
    const r = await api.get('/api/admin/driver-day-overrides')
    overrides.value = r.overrides || []
    drivers.value = r.drivers || []
  } catch (err) {
    toast(err?.message || 'Failed to load overrides', 'error')
  } finally {
    loading.value = false
  }
}

async function submitOverride() {
  if (busy.value) return
  busy.value = true
  try {
    await api.post('/api/admin/excluded-days', {
      driverName: form.driverName,
      date: form.date,
      action: form.action,
      reason: form.reason || '',
    })
    toast(`${form.action === 'add' ? 'Added' : 'Removed'} ${formatDate(form.date)} for ${form.driverName}`)
    form.date = ''
    form.reason = ''
    // Keep driverName + action so a series of related entries is faster.
    await loadOverrides()
  } catch (err) {
    toast(err?.message || 'Failed to save override', 'error')
  } finally {
    busy.value = false
  }
}

async function removeOverride(row) {
  if (busyId.value) return
  busyId.value = row.id
  try {
    await api.del(`/api/admin/excluded-days/${row.id}`)
    toast(`Removed override for ${formatDate(row.excluded_date)}`)
    await loadOverrides()
  } catch (err) {
    toast(err?.message || 'Failed to remove override', 'error')
  } finally {
    busyId.value = 0
  }
}

function formatDate(ymd) {
  if (!ymd) return ''
  const [y, m, d] = ymd.split('-').map(Number)
  if (!y || !m || !d) return ymd
  return new Date(y, m - 1, d).toLocaleDateString('en-US', { weekday: 'short', month: 'short', day: 'numeric', year: 'numeric' })
}

function formatTs(iso) {
  if (!iso) return '—'
  const d = new Date(iso.includes('T') ? iso : iso.replace(' ', 'T') + 'Z')
  if (isNaN(d.getTime())) return iso
  const ageSec = Math.round((Date.now() - d.getTime()) / 1000)
  if (ageSec < 60) return `${ageSec}s ago`
  if (ageSec < 3600) return `${Math.round(ageSec / 60)}m ago`
  if (ageSec < 86400) return `${Math.round(ageSec / 3600)}h ago`
  return d.toLocaleString()
}

function titleCase(s) {
  return (s || '').replace(/\b\w/g, c => c.toUpperCase())
}

onMounted(loadOverrides)
</script>

<style scoped>
.admin-page {
  padding: 1.5rem; max-width: 1100px; margin: 0 auto;
}
.page-header { margin-bottom: 1.5rem; }
.page-header h2 { margin: 0 0 0.4rem; font-size: 1.5rem; }
.page-desc { color: var(--text-dim); font-size: 0.92rem; line-height: 1.5; margin: 0; }

.card {
  background: var(--surface);
  border: 1px solid var(--border);
  border-radius: var(--radius);
  margin-bottom: 1.25rem;
  overflow: hidden;
}
.card-header {
  display: flex; justify-content: space-between; align-items: center;
  padding: 0.85rem 1rem;
  border-bottom: 1px solid var(--border);
  background: var(--bg);
  flex-wrap: wrap; gap: 0.6rem;
}
.card-title {
  display: flex; align-items: center; gap: 0.5rem;
  font-weight: 700; font-size: 0.95rem;
}
.section-dot { width: 10px; height: 10px; border-radius: 50%; }
.count-badge {
  background: var(--accent-dim); color: var(--accent);
  font-size: 0.72rem; font-weight: 700;
  padding: 0.1rem 0.5rem; border-radius: 999px;
}
.card-body { padding: 1rem; }
.scan-empty {
  color: var(--text-dim); font-style: italic; text-align: center;
  padding: 1.5rem 1rem;
}

/* Form */
.form-grid {
  display: grid;
  grid-template-columns: 1fr 1fr;
  gap: 0.85rem 1rem;
  align-items: end;
}
.field { display: flex; flex-direction: column; gap: 0.3rem; }
.field-wide { grid-column: 1 / -1; }
.field-label {
  font-size: 0.78rem; font-weight: 600;
  color: var(--text-dim); text-transform: uppercase; letter-spacing: 0.04em;
}
.field-hint {
  font-weight: 400; text-transform: none; letter-spacing: 0;
  color: var(--text-dim); font-size: 0.72rem;
}
.field-input {
  font-family: inherit; font-size: 0.9rem;
  padding: 0.5rem 0.6rem;
  border: 1px solid var(--border); border-radius: 6px;
  background: var(--bg); color: var(--text);
}
.field-input:focus { outline: none; border-color: var(--accent); }
.action-toggle {
  display: flex; gap: 0.5rem;
}
.radio-pill {
  flex: 1; cursor: pointer;
  display: flex; align-items: center; justify-content: center;
  padding: 0.5rem 0.75rem;
  border: 1px solid var(--border); border-radius: 6px;
  font-size: 0.85rem; font-weight: 600;
  background: var(--bg); color: var(--text-dim);
  transition: all 0.12s;
}
.radio-pill input { display: none; }
.radio-pill:hover { border-color: var(--accent); }
.radio-pill.active {
  border-color: var(--accent); color: var(--accent);
  background: var(--accent-dim);
}
.field-actions { grid-column: 1 / -1; display: flex; justify-content: flex-end; }

/* Filter row */
.filter-row {
  display: flex; gap: 0.5rem; align-items: center;
}
.filter-input {
  font-family: inherit; font-size: 0.85rem;
  padding: 0.35rem 0.5rem;
  border: 1px solid var(--border); border-radius: 6px;
  background: var(--bg); color: var(--text);
}

/* Buttons */
.btn {
  font-family: inherit; font-weight: 600;
  border: 1px solid var(--border); border-radius: 6px;
  padding: 0.45rem 0.85rem; cursor: pointer;
  background: var(--surface); color: var(--text);
  transition: all 0.12s;
}
.btn:disabled { opacity: 0.5; cursor: default; }
.btn-sm { font-size: 0.8rem; padding: 0.35rem 0.65rem; }
.btn-xs { font-size: 0.72rem; padding: 0.2rem 0.5rem; }
.btn-primary { background: var(--accent); color: white; border-color: var(--accent); }
.btn-primary:hover:not(:disabled) { filter: brightness(1.08); }
.btn-secondary { background: var(--bg); }
.btn-secondary:hover:not(:disabled) { border-color: var(--accent); color: var(--accent); }
.btn-danger { color: var(--danger); border-color: var(--danger); background: transparent; }
.btn-danger:hover:not(:disabled) { background: var(--danger); color: white; }

/* Table */
.table-wrap { padding: 0; overflow-x: auto; }
.ovr-table {
  width: 100%; border-collapse: collapse;
  font-size: 0.88rem;
}
.ovr-table th, .ovr-table td {
  padding: 0.6rem 0.8rem;
  text-align: left;
  border-bottom: 1px solid var(--border);
}
.ovr-table th {
  font-size: 0.72rem; font-weight: 700;
  color: var(--text-dim); text-transform: uppercase; letter-spacing: 0.04em;
  background: var(--bg);
  position: sticky; top: 0;
}
.ovr-table tr:last-child td { border-bottom: none; }
.cell-driver { font-weight: 600; }
.cell-date { white-space: nowrap; }
.cell-reason {
  max-width: 280px;
  overflow: hidden; text-overflow: ellipsis; white-space: nowrap;
  color: var(--text-dim);
}
.cell-by, .cell-when { color: var(--text-dim); font-size: 0.82rem; white-space: nowrap; }
.action-badge {
  display: inline-block;
  padding: 0.15rem 0.55rem;
  border-radius: 4px;
  font-size: 0.74rem; font-weight: 700;
  text-transform: uppercase; letter-spacing: 0.03em;
}
.action-badge.add {
  background: rgba(34, 197, 94, 0.12); color: rgb(22, 163, 74);
}
.action-badge.remove {
  background: rgba(234, 179, 8, 0.12); color: rgb(180, 130, 0);
}

@media (max-width: 700px) {
  .form-grid { grid-template-columns: 1fr; }
  .filter-row { flex-wrap: wrap; }
  .cell-by, .cell-when { display: none; }
}
</style>
